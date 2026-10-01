#ifdef VERTEX
#version 300 es

#define HLSLCC_ENABLE_UNIFORM_BUFFERS 1
#if HLSLCC_ENABLE_UNIFORM_BUFFERS
#define UNITY_UNIFORM
#else
#define UNITY_UNIFORM uniform
#endif
#define UNITY_SUPPORTS_UNIFORM_LOCATION 1
#if UNITY_SUPPORTS_UNIFORM_LOCATION
#define UNITY_LOCATION(x) layout(location = x)
#define UNITY_BINDING(x) layout(binding = x, std140)
#else
#define UNITY_LOCATION(x)
#define UNITY_BINDING(x) layout(std140)
#endif
uniform 	vec3 _WorldSpaceCameraPos;
uniform 	vec4 _ScreenParams;
uniform 	vec4 hlslcc_mtx4x4unity_ObjectToWorld[4];
uniform 	vec4 hlslcc_mtx4x4unity_WorldToObject[4];
uniform 	vec4 hlslcc_mtx4x4glstate_matrix_projection[4];
uniform 	vec4 hlslcc_mtx4x4unity_MatrixVP[4];
uniform 	mediump vec4 _FaceColor;
uniform 	float _FaceDilate;
uniform 	float _OutlineSoftness;
uniform 	mediump vec4 _OutlineColor;
uniform 	float _OutlineWidth;
uniform 	float _UnderlayOffsetX;
uniform 	float _UnderlayOffsetY;
uniform 	float _UnderlayDilate;
uniform 	float _UnderlaySoftness;
uniform 	float _WeightNormal;
uniform 	float _WeightBold;
uniform 	float _ScaleRatioA;
uniform 	float _ScaleRatioC;
uniform 	float _VertexOffsetX;
uniform 	float _VertexOffsetY;
uniform 	vec4 _ClipRect;
uniform 	float _MaskSoftnessX;
uniform 	float _MaskSoftnessY;
uniform 	float _TextureWidth;
uniform 	float _TextureHeight;
uniform 	float _GradientScale;
uniform 	float _ScaleX;
uniform 	float _ScaleY;
uniform 	float _PerspectiveFilter;
uniform 	float _Sharpness;
uniform 	float _UIMaskSoftnessX;
uniform 	float _UIMaskSoftnessY;
in highp vec4 in_POSITION0;
in highp vec3 in_NORMAL0;
in mediump vec4 in_COLOR0;
in highp vec4 in_TEXCOORD0;
out mediump vec4 vs_COLOR0;
out mediump vec4 vs_COLOR1;
out highp vec4 vs_TEXCOORD0;
out mediump vec4 vs_TEXCOORD1;
mediump vec4 vs_TEXCOORD2;
out highp vec4 vs_TEXCOORD3;
out mediump vec2 vs_TEXCOORD4;
vec2 u_xlat0;
bool u_xlatb0;
vec4 u_xlat1;
vec4 u_xlat2;
vec4 u_xlat3;
mediump vec4 u_xlat16_3;
vec4 u_xlat4;
mediump vec4 u_xlat16_4;
vec4 u_xlat5;
mediump vec3 u_xlat16_5;
mediump vec4 u_xlat16_6;
vec3 u_xlat7;
float u_xlat14;
vec2 u_xlat15;
float u_xlat21;
bool u_xlatb21;
float u_xlat22;
void main()
{
    u_xlat0.xy = in_POSITION0.xy + vec2(_VertexOffsetX, _VertexOffsetY);
    u_xlat1 = u_xlat0.yyyy * hlslcc_mtx4x4unity_ObjectToWorld[1];
    u_xlat1 = hlslcc_mtx4x4unity_ObjectToWorld[0] * u_xlat0.xxxx + u_xlat1;
    u_xlat1 = hlslcc_mtx4x4unity_ObjectToWorld[2] * in_POSITION0.zzzz + u_xlat1;
    u_xlat2 = u_xlat1 + hlslcc_mtx4x4unity_ObjectToWorld[3];
    u_xlat1.xyz = hlslcc_mtx4x4unity_ObjectToWorld[3].xyz * in_POSITION0.www + u_xlat1.xyz;
    u_xlat1.xyz = (-u_xlat1.xyz) + _WorldSpaceCameraPos.xyz;
    u_xlat3 = u_xlat2.yyyy * hlslcc_mtx4x4unity_MatrixVP[1];
    u_xlat3 = hlslcc_mtx4x4unity_MatrixVP[0] * u_xlat2.xxxx + u_xlat3;
    u_xlat3 = hlslcc_mtx4x4unity_MatrixVP[2] * u_xlat2.zzzz + u_xlat3;
    u_xlat2 = hlslcc_mtx4x4unity_MatrixVP[3] * u_xlat2.wwww + u_xlat3;
    gl_Position = u_xlat2;
    vs_COLOR0.w = _FaceColor.w;
    u_xlat16_3.xyz = in_COLOR0.xyz;
    u_xlat16_3.w = 1.0;
    u_xlat16_4 = u_xlat16_3 * _FaceColor;
    u_xlat16_5.xyz = u_xlat16_4.www * u_xlat16_4.xyz;
    vs_COLOR0.xyz = u_xlat16_5.xyz;
    u_xlat5.xyz = (-u_xlat16_5.xyz);
    u_xlat5.w = (-u_xlat16_4.w);
    u_xlat16_6.xyz = _OutlineColor.www * _OutlineColor.xyz;
    u_xlat16_6.w = _OutlineColor.w;
    u_xlat5 = u_xlat5 + u_xlat16_6;
    u_xlat14 = dot(u_xlat1.xyz, u_xlat1.xyz);
    u_xlat14 = inversesqrt(u_xlat14);
    u_xlat1.xyz = vec3(u_xlat14) * u_xlat1.xyz;
    u_xlat2.x = dot(in_NORMAL0.xyz, hlslcc_mtx4x4unity_WorldToObject[0].xyz);
    u_xlat2.y = dot(in_NORMAL0.xyz, hlslcc_mtx4x4unity_WorldToObject[1].xyz);
    u_xlat2.z = dot(in_NORMAL0.xyz, hlslcc_mtx4x4unity_WorldToObject[2].xyz);
    u_xlat14 = dot(u_xlat2.xyz, u_xlat2.xyz);
    u_xlat14 = inversesqrt(u_xlat14);
    u_xlat2.xyz = vec3(u_xlat14) * u_xlat2.xyz;
    u_xlat14 = dot(u_xlat2.xyz, u_xlat1.xyz);
    u_xlat1.xy = _ScreenParams.yy * hlslcc_mtx4x4glstate_matrix_projection[1].xy;
    u_xlat1.xy = hlslcc_mtx4x4glstate_matrix_projection[0].xy * _ScreenParams.xx + u_xlat1.xy;
    u_xlat1.xy = abs(u_xlat1.xy) * vec2(_ScaleX, _ScaleY);
    u_xlat1.xy = u_xlat2.ww / u_xlat1.xy;
    u_xlat21 = dot(u_xlat1.xy, u_xlat1.xy);
    u_xlat21 = inversesqrt(u_xlat21);
    u_xlat15.x = abs(in_TEXCOORD0.w) * _GradientScale;
    u_xlat22 = _Sharpness + 1.0;
    u_xlat15.x = u_xlat22 * u_xlat15.x;
    u_xlat22 = u_xlat21 * u_xlat15.x;
    u_xlat2.x = (-_PerspectiveFilter) + 1.0;
    u_xlat2.x = abs(u_xlat22) * u_xlat2.x;
    u_xlat21 = u_xlat21 * u_xlat15.x + (-u_xlat2.x);
    u_xlat14 = abs(u_xlat14) * u_xlat21 + u_xlat2.x;
    u_xlatb21 = hlslcc_mtx4x4glstate_matrix_projection[3].w==0.0;
    u_xlat14 = (u_xlatb21) ? u_xlat14 : u_xlat22;
    u_xlat21 = _OutlineSoftness * _ScaleRatioA;
    u_xlat21 = u_xlat21 * u_xlat14 + 1.0;
    u_xlat2.x = u_xlat14 / u_xlat21;
    u_xlat21 = _OutlineWidth * _ScaleRatioA;
    u_xlat21 = u_xlat2.x * u_xlat21;
    u_xlat15.x = min(u_xlat21, 1.0);
    u_xlat15.x = sqrt(u_xlat15.x);
    u_xlat5 = u_xlat5 * u_xlat15.xxxx;
    u_xlat4.xyz = u_xlat16_4.xyz * u_xlat16_4.www + u_xlat5.xyz;
    u_xlat4.w = u_xlat16_3.w * _FaceColor.w + u_xlat5.w;
    vs_COLOR1 = u_xlat4;
    u_xlat3 = max(_ClipRect, vec4(-2e+10, -2e+10, -2e+10, -2e+10));
    u_xlat3 = min(u_xlat3, vec4(2e+10, 2e+10, 2e+10, 2e+10));
    u_xlat15.xy = u_xlat0.xy + (-u_xlat3.xy);
    u_xlat0.xy = u_xlat0.xy * vec2(2.0, 2.0) + (-u_xlat3.xy);
    u_xlat4.xy = (-u_xlat3.zw) + u_xlat0.xy;
    u_xlat0.xy = (-u_xlat3.xy) + u_xlat3.zw;
    vs_TEXCOORD0.zw = u_xlat15.xy / u_xlat0.xy;
    vs_TEXCOORD0.xy = in_TEXCOORD0.xy;
    u_xlatb0 = 0.0>=in_TEXCOORD0.w;
    u_xlat0.x = u_xlatb0 ? 1.0 : float(0.0);
    u_xlat7.x = (-_WeightNormal) + _WeightBold;
    u_xlat0.x = u_xlat0.x * u_xlat7.x + _WeightNormal;
    u_xlat0.x = u_xlat0.x * 0.25 + _FaceDilate;
    u_xlat0.x = u_xlat0.x * _ScaleRatioA;
    u_xlat0.x = (-u_xlat0.x) * 0.5 + 0.5;
    u_xlat2.w = u_xlat0.x * u_xlat2.x + -0.5;
    u_xlat2.y = (-u_xlat21) * 0.5 + u_xlat2.w;
    u_xlat2.z = u_xlat21 * 0.5 + u_xlat2.w;
    vs_TEXCOORD1 = u_xlat2;
    u_xlat7.xz = max(vec2(_MaskSoftnessX, _MaskSoftnessY), vec2(_UIMaskSoftnessX, _UIMaskSoftnessY));
    u_xlat7.xz = u_xlat7.xz * vec2(0.25, 0.25) + u_xlat1.xy;
    u_xlat4.zw = vec2(0.25, 0.25) / u_xlat7.xz;
    vs_TEXCOORD2 = u_xlat4;
    vs_TEXCOORD3.z = in_COLOR0.w;
    vs_TEXCOORD3.w = 0.0;
    u_xlat1 = vec4(_UnderlaySoftness, _UnderlayDilate, _UnderlayOffsetX, _UnderlayOffsetY) * vec4(vec4(_ScaleRatioC, _ScaleRatioC, _ScaleRatioC, _ScaleRatioC));
    u_xlat7.xz = (-u_xlat1.zw) * vec2(_GradientScale);
    u_xlat7.xz = u_xlat7.xz / vec2(_TextureWidth, _TextureHeight);
    vs_TEXCOORD3.xy = u_xlat7.xz + in_TEXCOORD0.xy;
    u_xlat7.x = u_xlat1.x * u_xlat14 + 1.0;
    u_xlat2.x = u_xlat14 / u_xlat7.x;
    u_xlat7.x = u_xlat1.y * u_xlat2.x;
    u_xlat0.x = u_xlat0.x * u_xlat2.x + -0.5;
    u_xlat2.y = (-u_xlat7.x) * 0.5 + u_xlat0.x;
    vs_TEXCOORD4.xy = u_xlat2.xy;
    return;
}

#endif
#ifdef FRAGMENT
#version 300 es

precision highp float;
precision highp int;
#define HLSLCC_ENABLE_UNIFORM_BUFFERS 1
#if HLSLCC_ENABLE_UNIFORM_BUFFERS
#define UNITY_UNIFORM
#else
#define UNITY_UNIFORM uniform
#endif
#define UNITY_SUPPORTS_UNIFORM_LOCATION 1
#if UNITY_SUPPORTS_UNIFORM_LOCATION
#define UNITY_LOCATION(x) layout(location = x)
#define UNITY_BINDING(x) layout(binding = x, std140)
#else
#define UNITY_LOCATION(x)
#define UNITY_BINDING(x) layout(std140)
#endif
uniform 	mediump vec4 _UnderlayColor;
UNITY_LOCATION(0) uniform mediump sampler2D _MainTex;
in mediump  vec4 vs_COLOR0;
in mediump  vec4 vs_COLOR1;
in highp  vec4 vs_TEXCOORD0;
in mediump  vec4 vs_TEXCOORD1;
in highp  vec4 vs_TEXCOORD3;
in mediump  vec2 vs_TEXCOORD4;
layout(location = 0) out mediump vec4 SV_Target0;
vec4 u_xlat0;
mediump vec4 u_xlat16_0;
mediump vec4 u_xlat16_1;
mediump vec4 u_xlat16_2;
mediump vec2 u_xlat16_3;
void main()
{
    u_xlat16_0.x = texture(_MainTex, vs_TEXCOORD3.xy).w;
    u_xlat16_1.x = u_xlat16_0.x * vs_TEXCOORD4.x + (-vs_TEXCOORD4.y);
    u_xlat16_1.x = clamp(u_xlat16_1.x, 0.0, 1.0);
    u_xlat16_0.xyz = _UnderlayColor.www * _UnderlayColor.xyz;
    u_xlat16_0.w = _UnderlayColor.w;
    u_xlat0 = u_xlat16_1.xxxx * u_xlat16_0;
    u_xlat16_1 = vs_COLOR0 + (-vs_COLOR1);
    u_xlat16_2.x = texture(_MainTex, vs_TEXCOORD0.xy).w;
    u_xlat16_3.xy = u_xlat16_2.xx * vs_TEXCOORD1.xx + (-vs_TEXCOORD1.zy);
    u_xlat16_3.xy = clamp(u_xlat16_3.xy, 0.0, 1.0);
    u_xlat16_1 = u_xlat16_3.xxxx * u_xlat16_1 + vs_COLOR1;
    u_xlat16_2 = u_xlat16_3.yyyy * u_xlat16_1;
    u_xlat16_1.x = (-u_xlat16_1.w) * u_xlat16_3.y + 1.0;
    u_xlat0 = u_xlat0 * u_xlat16_1.xxxx + u_xlat16_2;
    u_xlat0 = u_xlat0 * vs_TEXCOORD3.zzzz;
    SV_Target0 = u_xlat0;
    return;
}

#endif
