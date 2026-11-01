// Packed-alpha proxies (media/src/proxy.ts, PACKED_ALPHA): the engine stores a transparent
// video as one ordinary H.264 file, colour on top and its alpha as grey below, because WKWebView
// and Chromium share no video codec with alpha. This turns a frame of one back into a picture
// with transparency, which the compositor then draws like any other source.

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2((pos.x + 1.0) / 2.0, (1.0 - pos.y) / 2.0); // top-left origin, like the video
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D src;
in vec2 uv;
out vec4 o;
void main() {
  vec3 c = texture(src, vec2(uv.x, uv.y * 0.5)).rgb;
  float a = texture(src, vec2(uv.x, 0.5 + uv.y * 0.5)).r;
  // H.264 nudges the extremes (opaque decodes ~253, clear ~1); snap them so flat areas stay flat.
  a = clamp((a - 0.012) / (0.988 - 0.012), 0.0, 1.0);
  o = vec4(c * a, a); // the canvas expects premultiplied alpha
}`;

export class AlphaUnpack {
  readonly canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #tex: WebGLTexture;

  static create(): AlphaUnpack | null {
    try {
      return new AlphaUnpack();
    } catch {
      return null;
    }
  }

  private constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error("no WebGL2");
    this.#gl = gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.#tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Unpack the current frame of a packed video; the result is `canvas`, w × h/2. */
  render(video: HTMLVideoElement): HTMLCanvasElement {
    const gl = this.#gl;
    const w = video.videoWidth;
    const h = Math.floor(video.videoHeight / 2);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
