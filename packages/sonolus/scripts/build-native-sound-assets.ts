#!/usr/bin/env node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import {
    nativeSoundGroups, nativeSoundTypes, nativeSoundCueSuffixes, nativeSoundPackClips,
} from '../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeSound.ts'
import { resolveSonolusReleaseWorkspace } from '../src/server/releaseWorkspace.ts'
import { validateSonolusInputProvenance } from '../src/server/sonolusProvenance.ts'

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd())
const workspace = resolveSonolusReleaseWorkspace(process.env.RELEASE_SERVER || 'intl', root)
const provenance = validateSonolusInputProvenance(workspace, root)
const source = resolve(workspace.runtimeRoot, 'note-se')
const output = resolve(process.env.SONOLUS_ORIGINAL_ASSETS_DIR || resolve(root, 'packages/sonolus/assets/original'))
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const cri = JSON.parse(readFileSync(resolve(workspace.metadataRoot, 'cri.json'), 'utf8')) as {
    entries: Array<{ runtimePath?: string; semanticDecodeProfile?: string }>
}
const records = cri.entries.filter((entry) => entry.runtimePath === 'note-se')
if (!records.length || records.some((entry) => entry.semanticDecodeProfile !== 'note-se-original-stream-once-v1'))
    throw new Error('Rebuild native note SE with the original stream once decode profile')

function run(command: string, args: string[]) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
}

const staging = mkdtempSync(resolve(tmpdir(), 'our-notes-native-sound-'))
try {
    for (const group of nativeSoundGroups) {
        const directory = resolve(staging, String(group.id))
        mkdirSync(directory)
        const entries: string[] = []
        const epoch = new Date('2000-01-01T00:00:00Z')
        const filenames = new Map<string, string>()

        function addWaveform(cue: string, gain?: number) {
            const key = `${cue}:${gain ?? 1}`
            const existing = filenames.get(key)
            if (existing) return existing
            const filename = String(entries.length) + (gain === undefined ? '' : '.wav')
            const destination = resolve(directory, filename)
            const input = resolve(source, `${cue}.mp3`)
            if (gain === undefined) copyFileSync(input, destination)
            else run(ffmpeg, [
                '-nostdin', '-loglevel', 'error', '-y', '-i', input,
                '-af', `volume=${gain}`, '-map_metadata', '-1', '-ar', '48000', '-ac', '2',
                // A second MP3 encode changes the scaled waveform. PCM keeps
                // each native layer's sample count and gain at the loop seam.
                '-codec:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact',
                '-f', 'wav', destination,
            ])
            utimesSync(destination, epoch, epoch)
            entries.push(destination)
            filenames.set(key, filename)
            return filename
        }

        function typeFilename(type: number) {
            const suffix = nativeSoundCueSuffixes[type - 1]
            if (!suffix) throw new Error(`Invalid native sound type: ${type}`)
            const cue = type === 8 ? suffix : `${group.prefix}_${suffix}`
            if (type === 7) return addWaveform(group.id === 1 ? 'default_long_1' : cue, group.holdGains[0])
            return addWaveform(cue)
        }

        const clipDefinitions = [
            ...nativeSoundPackClips,
            ...nativeSoundTypes.map((name, index) => [
                `Our Notes Native Type ${String(index + 1).padStart(2, '0')} ${name}`, index + 1,
            ] as const),
        ]
        const clips = clipDefinitions.map(([name, type]) => ({ name, filename: typeFilename(type) }))
        if (group.id === 1) clips.push({
            name: 'Our Notes Hold Layer 2', filename: addWaveform('default_long_2', group.holdGains[1]),
        })

        const archive = resolve(directory, 'effect.audio')
        run('zip', ['-X', '-j', '-0', archive, ...entries])
        const destination = resolve(output, 'effects', String(group.id))
        mkdirSync(destination, { recursive: true })
        copyFileSync(archive, resolve(destination, 'effect.audio'))
        writeFileSync(resolve(destination, 'effect.data'), gzipSync(JSON.stringify({ clips }), { level: 9 }))
        if (group.id === 1) {
            copyFileSync(archive, resolve(output, 'effect.audio'))
            copyFileSync(resolve(destination, 'effect.data'), resolve(output, 'effect.data'))
        }
        console.log(`${group.name}: ${clips.length} clips, ${entries.length} independent waveforms`)
    }
    console.log(`Native sound source: ${provenance.sourceId}, ${provenance.releaseId}`)
} finally {
    rmSync(staging, { recursive: true, force: true })
}
