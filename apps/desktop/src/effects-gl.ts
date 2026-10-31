// Picture effects for the live preview, on the GPU. Mirrors effectFilters() in
// media/src/compile.ts step by step (colour matrix, Gaussian blur, 3×3 sharpen
// with repeated edges, cos⁴ vignette, uniform luma grain) using the parameters
// from @reelforge/core/effects, at 8 bits between passes like FFmpeg.

import { blurSigma, colorMatrix, grainNoise, sharpenAmount, vignetteAngle } from "@reelforge/core/effects";
import type { ClipProps } from "@reelforge/core/schema";

const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

// Textures keep the picture upright in GL terms (row 0 = bottom), except the source,
// whose row 0 is the image's top: the fit pass flips it.
const FIT = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 size;
uniform vec4 crop; // x, y, w, h in source UV, top-left origin
uniform mat3 color;
uniform bool useColor;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec4 c = texture(src, crop.xy + vec2(uv.x, 1.0 - uv.y) * crop.zw);
  if (useColor) c.rgb = clamp(color * c.rgb, 0.0, 1.0);
  o = c;
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D img;
uniform vec2 dir;
uniform float sigma;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(img, 0) - 1;
  int r = int(ceil(3.0 * sigma));
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -r; i <= r; i++) {
    float w = exp(-0.5 * float(i * i) / (sigma * sigma));
    sum += w * texelFetch(img, clamp(p + ivec2(dir) * i, ivec2(0), last), 0).rgb;
    wsum += w;
  }
  o = vec4(sum / wsum, texelFetch(img, p, 0).a);
}`;

const FINISH = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D img;
uniform float sharpen;
uniform float angle;
uniform float grain;
uniform uint frame;
out vec4 o;
vec3 at(ivec2 p, ivec2 last) { return texelFetch(img, clamp(p, ivec2(0), last), 0).rgb; }
uint hash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(img, 0) - 1;
  vec4 c = texelFetch(img, p, 0);
  if (sharpen > 0.0) {
    vec3 n = at(p + ivec2(1, 0), last) + at(p - ivec2(1, 0), last) + at(p + ivec2(0, 1), last) + at(p - ivec2(0, 1), last);
    c.rgb = clamp((1.0 + 4.0 * sharpen) * c.rgb - sharpen * n, 0.0, 1.0);
  }
  if (angle > 0.0) {
    vec2 size = vec2(last + 1);
    // FFmpeg measures from integer pixel positions to (w/2, h/2).
    float d = length(floor(gl_FragCoord.xy) - size / 2.0) / length(size / 2.0);
    float k = d > 1.0 ? 0.0 : pow(cos(angle * d), 4.0);
    c.rgb *= k;
  }
  if (grain > 0.0) {
    uint h = hash(uint(p.x) * 73856093u ^ uint(p.y) * 19349663u ^ hash(frame));
    c.rgb = clamp(c.rgb + (float(h) / 4294967295.0 * 2.0 - 1.0) * grain, 0.0, 1.0);
  }
  o = c;
}`;

interface Pass {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export class EffectsGL {
  readonly canvas: HTMLCanvasElement;
  #gl: WebGL2RenderingContext;
  #fit: Pass;
  #blur: Pass;
  #finish: Pass;
  #src: WebGLTexture;
  #targets: { tex: WebGLTexture; fb: WebGLFramebuffer }[] = [];
  #w = 0;
  #h = 0;

  /** Null when the webview has no WebGL 2; the preview then shows clips without effects. */
  static create(): EffectsGL | null {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      return gl ? new EffectsGL(canvas, gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.#gl = gl;
    this.#fit = this.#program(FIT, ["src", "size", "crop", "color", "useColor"]);
    this.#blur = this.#program(BLUR, ["img", "dir", "sigma"]);
    this.#finish = this.#program(FINISH, ["img", "sharpen", "angle", "grain", "frame"]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.#src = this.#texture();
  }

  #program(frag: string, uniforms: string[]): Pass {
    const gl = this.#gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, "pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link error");
    return { prog, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(prog, n)])) };
  }

  #texture(): WebGLTexture {
    const gl = this.#gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  #resize(w: number, h: number) {
    if (w === this.#w && h === this.#h) return;
    const gl = this.#gl;
    for (const t of this.#targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.#targets = [0, 1].map(() => {
      const tex = this.#texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    });
    this.canvas.width = w;
    this.canvas.height = h;
    this.#w = w;
    this.#h = h;
  }

  #draw(pass: Pass, input: WebGLTexture, target: WebGLFramebuffer | null) {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.#w, this.#h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * The source region (sx, sy, sw, sh of a srcW×srcH image) fitted to w×h canvas pixels with the
   * clip's effects applied. frameWidth is the output frame width in the same pixels (blur scales
   * with it); frame seeds the grain.
   */
  render(
    src: TexImageSource,
    region: { sx: number; sy: number; sw: number; sh: number; srcW: number; srcH: number },
    w: number,
    h: number,
    props: ClipProps,
    frameWidth: number,
    frame: number,
  ): HTMLCanvasElement {
    const gl = this.#gl;
    this.#resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    gl.bindTexture(gl.TEXTURE_2D, this.#src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const [a, b] = this.#targets as [{ tex: WebGLTexture; fb: WebGLFramebuffer }, { tex: WebGLTexture; fb: WebGLFramebuffer }];

    const m = colorMatrix(props);
    gl.useProgram(this.#fit.prog);
    gl.uniform1i(this.#fit.u.src!, 0);
    gl.uniform2f(this.#fit.u.size!, this.#w, this.#h);
    gl.uniform4f(this.#fit.u.crop!, region.sx / region.srcW, region.sy / region.srcH, region.sw / region.srcW, region.sh / region.srcH);
    gl.uniform1i(this.#fit.u.useColor!, m ? 1 : 0);
    // GLSL matrices are column-major; ours is row-major.
    if (m) gl.uniformMatrix3fv(this.#fit.u.color!, true, m);
    this.#draw(this.#fit, this.#src, a.fb);

    const sigma = blurSigma(props, frameWidth);
    if (sigma >= 0.1) {
      gl.useProgram(this.#blur.prog);
      gl.uniform1i(this.#blur.u.img!, 0);
      gl.uniform1f(this.#blur.u.sigma!, sigma);
      gl.uniform2f(this.#blur.u.dir!, 1, 0);
      this.#draw(this.#blur, a.tex, b.fb);
      gl.uniform2f(this.#blur.u.dir!, 0, 1);
      this.#draw(this.#blur, b.tex, a.fb);
    }

    gl.useProgram(this.#finish.prog);
    gl.uniform1i(this.#finish.u.img!, 0);
    gl.uniform1f(this.#finish.u.sharpen!, sharpenAmount(props));
    gl.uniform1f(this.#finish.u.angle!, vignetteAngle(props));
    gl.uniform1f(this.#finish.u.grain!, grainNoise(props).amplitude);
    gl.uniform1ui(this.#finish.u.frame!, frame >>> 0);
    this.#draw(this.#finish, a.tex, null);
    return this.canvas;
  }
}
