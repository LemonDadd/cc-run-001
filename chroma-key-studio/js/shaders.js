/* ===== GLSL 着色器源码（WebGL2 / GLSL ES 3.00） ===== */
window.CK = window.CK || {};
(function () {
  const CK = window.CK;
  CK.Shaders = {};

  CK.Shaders.VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  /* ---- Pass 1: 色度键抠像 + 溢色抑制 + 前景调色，输出 RGBA(前景, alpha) ---- */
  CK.Shaders.KEY_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uVideo;
uniform sampler2D uCurve;
uniform vec3  uKeyColor;
uniform int   uSpace;        // 0=RGB 1=YUV 2=HSV
uniform float uSimilarity;
uniform float uSmoothness;
uniform float uFeather;
uniform float uShrink;
uniform int   uSpillType;    // 1=green 2=blue
uniform float uSpillStrength;
uniform float uEdgeCorrect;
uniform float uBrightness, uContrast, uSaturation, uTemperature, uTint;
uniform float uColorMatch, uLightUnify;
uniform vec3  uBgAvg, uFgAvg;
uniform float uBypass;

vec3 rgb2yuv(vec3 c){
  float y = 0.299*c.r + 0.587*c.g + 0.114*c.b;
  return vec3(y, 0.5 + (c.b - y)*0.564, 0.5 + (c.r - y)*0.713);
}
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.bg, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0*d + e)), d / (q.x + e), q.x);
}
float keyDist(vec3 c, vec3 k){
  if(uSpace == 0){ return distance(c, k) / 1.7320508; }
  if(uSpace == 1){
    vec3 a = rgb2yuv(c), b = rgb2yuv(k);
    vec3 d = a - b;
    return length(vec3(d.x*0.5, d.y, d.z)) / 1.5;
  }
  vec3 a = rgb2hsv(c), b = rgb2hsv(k);
  vec2 va = vec2(cos(a.x*6.2831853), sin(a.x*6.2831853)) * a.y;
  vec2 vb = vec2(cos(b.x*6.2831853), sin(b.x*6.2831853)) * b.y;
  return clamp(length(va - vb)*0.7 + abs(a.z - b.z)*0.3, 0.0, 1.0);
}
void main(){
  vec3 c = texture(uVideo, vUV).rgb;
  if(uBypass > 0.5){ outColor = vec4(c, 1.0); return; }

  float d = keyDist(c, uKeyColor);
  float e0 = uSimilarity - uSmoothness - uFeather*0.5;
  float e1 = max(uSimilarity + uSmoothness + uFeather*0.5, e0 + 1e-4);
  float alpha = smoothstep(e0, e1, d);
  alpha = clamp((alpha - uShrink*0.5) / max(1.0 - uShrink*0.5, 1e-3), 0.0, 1.0);

  // 溢色抑制：削减超过 max(r,b) 的绿色分量（蓝色同理），并对溢色区去饱和
  float excess = 0.0;
  if(uSpillType == 1){ excess = max(0.0, c.g - max(c.r, c.b)); c.g -= excess * uSpillStrength; }
  else if(uSpillType == 2){ excess = max(0.0, c.b - max(c.r, c.g)); c.b -= excess * uSpillStrength; }
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(lum), clamp(excess*2.0, 0.0, 1.0) * uSpillStrength * 0.5);

  // 边缘颜色校正：半透明边缘带去饱和，抑制残留色边
  float edge = smoothstep(0.02, 0.4, alpha) * (1.0 - smoothstep(0.6, 0.98, alpha));
  c = mix(c, vec3(lum), edge * uEdgeCorrect * 0.6);

  // 前景调色
  c += uBrightness;
  c = (c - 0.5) * uContrast + 0.5;
  float l2 = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l2), c, uSaturation);
  c.r += uTemperature * 0.08;
  c.b -= uTemperature * 0.08;
  c.g += uTint * 0.06;
  c = clamp(c, 0.0, 1.0);
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).r;
  c.b = texture(uCurve, vec2(c.b, 0.5)).r;

  // 前景↔背景色彩匹配 + 光照统一
  vec3 ratio = uBgAvg / max(uFgAvg, vec3(0.03));
  c *= mix(vec3(1.0), clamp(ratio, vec3(0.5), vec3(2.0)), uColorMatch * 0.6);
  float lf = dot(uFgAvg, vec3(0.299, 0.587, 0.114));
  float lb = dot(uBgAvg, vec3(0.299, 0.587, 0.114));
  c *= mix(1.0, clamp(lb / max(lf, 0.03), 0.5, 2.0), uLightUnify * 0.7);

  outColor = vec4(clamp(c, 0.0, 1.0), alpha);
}
`;

  /* ---- Pass 2: 形态学腐蚀/膨胀（可分离 min/max 滤波，仅作用于 alpha） ---- */
  CK.Shaders.MORPH_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec2  uDir;      // (1,0) 水平 / (0,1) 垂直
uniform int   uRadius;   // <= 12
uniform int   uMode;     // 0=腐蚀(min) 1=膨胀(max)
void main(){
  vec4 c = texture(uTex, vUV);
  float a = c.a;
  for(int i = 1; i <= 12; i++){
    if(i > uRadius) break;
    vec2 o = uDir * uTexel * float(i);
    float a1 = texture(uTex, vUV + o).a;
    float a2 = texture(uTex, vUV - o).a;
    if(uMode == 0) a = min(a, min(a1, a2));
    else           a = max(a, max(a1, a2));
  }
  outColor = vec4(c.rgb, a);
}
`;

  /* ---- Pass 3: 3x3 中值滤波（噪点抑制，仅 alpha） ---- */
  CK.Shaders.MEDIAN_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform float uStrength;
void s2(inout float a, inout float b){ float t = min(a, b); b = max(a, b); a = t; }
void main(){
  vec4 c = texture(uTex, vUV);
  float v[9];
  v[0] = texture(uTex, vUV + uTexel*vec2(-1.0,-1.0)).a;
  v[1] = texture(uTex, vUV + uTexel*vec2( 0.0,-1.0)).a;
  v[2] = texture(uTex, vUV + uTexel*vec2( 1.0,-1.0)).a;
  v[3] = texture(uTex, vUV + uTexel*vec2(-1.0, 0.0)).a;
  v[4] = c.a;
  v[5] = texture(uTex, vUV + uTexel*vec2( 1.0, 0.0)).a;
  v[6] = texture(uTex, vUV + uTexel*vec2(-1.0, 1.0)).a;
  v[7] = texture(uTex, vUV + uTexel*vec2( 0.0, 1.0)).a;
  v[8] = texture(uTex, vUV + uTexel*vec2( 1.0, 1.0)).a;
  s2(v[1],v[2]); s2(v[4],v[5]); s2(v[7],v[8]);
  s2(v[0],v[1]); s2(v[3],v[4]); s2(v[6],v[7]);
  s2(v[1],v[2]); s2(v[4],v[5]); s2(v[7],v[8]);
  s2(v[0],v[3]); s2(v[5],v[8]); s2(v[4],v[7]);
  s2(v[3],v[6]); s2(v[1],v[4]); s2(v[2],v[5]);
  s2(v[4],v[7]); s2(v[4],v[2]); s2(v[6],v[4]); s2(v[4],v[2]);
  outColor = vec4(c.rgb, mix(c.a, v[4], uStrength));
}
`;

  /* ---- Pass 4: 高斯模糊（可分离，mode 0=仅alpha 1=RGB，用于遮罩羽化与背景模糊） ---- */
  CK.Shaders.BLUR_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec2  uDir;
uniform float uRadius;   // 像素
uniform int   uMode;     // 0=仅alpha 1=整图RGB
void main(){
  vec2 stepv = uDir * uTexel * max(uRadius, 0.0) * 0.5;
  vec2 o1 = stepv * 1.3846153846;
  vec2 o2 = stepv * 3.2307692308;
  vec4 c = texture(uTex, vUV);
  if(uMode == 0){
    float a = c.a * 0.2270270270;
    a += (texture(uTex, vUV + o1).a + texture(uTex, vUV - o1).a) * 0.3162162162;
    a += (texture(uTex, vUV + o2).a + texture(uTex, vUV - o2).a) * 0.0702702703;
    outColor = vec4(c.rgb, a);
  } else {
    vec4 sum = c * 0.2270270270;
    sum += (texture(uTex, vUV + o1) + texture(uTex, vUV - o1)) * 0.3162162162;
    sum += (texture(uTex, vUV + o2) + texture(uTex, vUV - o2)) * 0.0702702703;
    outColor = sum;
  }
}
`;

  /* ---- Pass 5: 半透明区域保留（形态学/模糊后与原始 alpha 按边缘带混合） ---- */
  CK.Shaders.KEEPSEMI_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uOrig;
uniform sampler2D uMorphed;
uniform float uKeep;
void main(){
  vec4 o = texture(uOrig, vUV);
  vec4 m = texture(uMorphed, vUV);
  float band = smoothstep(0.02, 0.4, o.a) * (1.0 - smoothstep(0.6, 0.98, o.a));
  outColor = vec4(m.rgb, mix(m.a, o.a, uKeep * band));
}
`;

  /* ---- Pass 6: 背景合成（支持纯色/纹理背景、缩放位移、cover 适配） ---- */
  CK.Shaders.COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uFg;
uniform sampler2D uBg;
uniform int   uBgIsColor;
uniform vec3  uBgColor;
uniform vec2  uBgScale;    // 背景可见区域比例（cover × 用户缩放）
uniform vec2  uBgOffset;
void main(){
  vec4 fg = texture(uFg, vUV);
  vec3 bg;
  if(uBgIsColor == 1){
    bg = uBgColor;
  } else {
    vec2 buv = (vUV - 0.5) * uBgScale + 0.5 - uBgOffset;
    bg = texture(uBg, clamp(buv, 0.0, 1.0)).rgb;
  }
  outColor = vec4(mix(bg, fg.rgb, fg.a), 1.0);
}
`;

  /* ---- 通用 blit（复制 / alpha 转灰度，用于遮罩预览回读） ---- */
  CK.Shaders.BLIT_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform int uAlphaGray;
void main(){
  vec4 c = texture(uTex, vUV);
  outColor = (uAlphaGray == 1) ? vec4(vec3(c.a), 1.0) : c;
}
`;
})();
