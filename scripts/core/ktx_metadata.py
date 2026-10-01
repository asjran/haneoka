"""Refresh reusable native KTX metadata from verified physical levels."""
from __future__ import annotations
import hashlib
from pathlib import Path
from build.live2d_textures import encoder_profile, texture_variant_cache_key, _validate_ktx2_sampling
from core.hashes import sha256_file

MAGIC=b'\xabKTX 20\xbb\r\n\x1a\n'

def native_variant_metadata(variant: dict, output: Path, *, source_url: str | None = None) -> dict:
    """Keep provenance while reading codec, mips and GPU bytes from the KTX.

    Caller first verifies the file against its pinned release entry. Native
    ASTC also has to match the declared original block hash; no mip count is
    supplied by the prior metadata or guessed from the PNG.
    """
    with output.open('rb') as stream:
        header=stream.read(80)
        if len(header)!=80 or header[:12]!=MAGIC:raise ValueError('invalid reusable KTX2 header')
        u32=lambda i:int.from_bytes(header[i:i+4],'little')
        width,height,mips,scheme=u32(20),u32(24),u32(40),u32(44)
        format_name={165:'astc6x6',145:'bc7'}.get(u32(12))
        if (format_name is None or format_name!=variant.get('format') or u32(16)!=1 or width<=0 or height<=0
                or u32(28) or u32(32) or u32(36)!=1 or not 1<=mips<=max(width,height).bit_length()
                or scheme!=(0 if format_name=='astc6x6' else 3)):
            raise ValueError('unsupported reusable native KTX2 layout')
        if (width,height)!=(variant.get('width'),variant.get('height')):raise ValueError('reusable KTX2 dimensions changed')
        index=stream.read(24*mips)
        if len(index)!=24*mips:raise ValueError('truncated reusable KTX2 levels')
        ranges=[];gpu_bytes=0;blocks=hashlib.sha256()
        for level in range(mips):
            start=24*level
            offset=int.from_bytes(index[start:start+8],'little');length=int.from_bytes(index[start+8:start+16],'little');logical=int.from_bytes(index[start+16:start+24],'little')
            block=6 if format_name=='astc6x6' else 4
            expected=((max(1,width>>level)+block-1)//block)*((max(1,height>>level)+block-1)//block)*16
            if offset<80+24*mips or length<=0 or offset+length>output.stat().st_size or logical!=expected:
                raise ValueError('reusable KTX2 mip range differs from block geometry')
            if any(offset<end and offset+length>begin for begin,end in ranges):raise ValueError('overlapping reusable KTX2 levels')
            ranges.append((offset,offset+length));gpu_bytes+=logical
            if format_name=='astc6x6':
                if length!=logical:raise ValueError('native ASTC level was re-encoded')
                stream.seek(offset);remaining=length
                while remaining:
                    chunk=stream.read(min(1024*1024,remaining))
                    if not chunk:raise ValueError('truncated ASTC block payload')
                    blocks.update(chunk);remaining-=len(chunk)
    if format_name=='astc6x6' and blocks.hexdigest()!=variant.get('sourcePayloadSha256'):
        raise ValueError('reusable ASTC block hash differs from original payload')
    orientation='ru' if format_name=='astc6x6' else 'rd'
    _validate_ktx2_sampling(output,header+index,orientation)
    profile=variant.get('encoderProfile',{})
    version=profile.get('toolVersion')
    if not isinstance(version,str) or not version:raise ValueError('reusable KTX2 producer version is missing')
    source_hash=variant.get('sourceTextureSha256')
    if not isinstance(source_hash,str) or len(source_hash)!=64:raise ValueError('reusable KTX2 PNG provenance is missing')
    result={**variant,'source':source_url or variant.get('source'),'width':width,'height':height,'mipCount':mips,
            'container':'ktx2','format':format_name,'requiresTranscoding':False,'lossyReencoded':format_name=='bc7',
            'orientation':orientation,'flipY':format_name=='astc6x6','transferFunction':'linear','alphaMode':'straight',
            'gpuByteLength':gpu_bytes,'byteLength':output.stat().st_size,'sha256':sha256_file(output),
            'encoderProfile':encoder_profile(format_name,version,mip_count=mips if format_name=='astc6x6' else 1),
            'cacheKey':texture_variant_cache_key(format_name,source_hash,width,height,version,
                        source_payload_sha256=variant.get('sourcePayloadSha256') if format_name=='astc6x6' else None,
                        mip_count=mips if format_name=='astc6x6' else 1)}
    return result
