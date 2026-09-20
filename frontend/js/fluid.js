/**
 * Interactive WebGL fluid backdrop.
 * It is visual only and never intercepts pointer input.
 */
(function () {
  const canvas = document.getElementById('fluid-canvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const gl = canvas.getContext('webgl', { powerPreference: 'high-performance', alpha: false });
  if (!gl) return;

  const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_mouse_velocity;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      vec2 i = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    vec2 curl(vec2 p) {
      const float eps = 0.005;
      float n1 = snoise(p + vec2(0.0, eps));
      float n2 = snoise(p - vec2(0.0, eps));
      float n3 = snoise(p + vec2(eps, 0.0));
      float n4 = snoise(p - vec2(eps, 0.0));
      return vec2((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
    }

    void main() {
      vec2 st = gl_FragCoord.xy / u_resolution.xy;
      float aspect = u_resolution.x / u_resolution.y;
      st.x *= aspect;

      vec2 mouseNorm = u_mouse * vec2(aspect, 1.0);
      float distToMouse = distance(st, mouseNorm);
      float ripple = exp(-distToMouse * 4.0) * (0.2 + u_mouse_velocity * 0.4);

      vec2 flow = curl(st * 0.65 + vec2(u_time * 0.015, u_time * 0.008));
      flow += curl(st * 1.2 - flow * 0.2 + vec2(-u_time * 0.012, u_time * 0.009)) * 0.4;
      vec2 mouseDir = normalize(st - mouseNorm + 0.0001);
      flow += mouseDir * ripple * 0.25;

      float pattern = snoise(st * 0.85 + flow * 0.6 + vec2(u_time * 0.008));
      pattern = pattern * 0.5 + 0.5;

      vec3 colorBase = vec3(0.032, 0.048, 0.065);
      vec3 colorSecondary = vec3(0.812, 0.827, 0.831);
      vec3 colorPrimary = vec3(0.502, 0.737, 0.812);
      vec3 colorDepth = vec3(0.055, 0.12, 0.16);

      vec3 col = mix(colorBase, colorDepth, smoothstep(0.2, 0.7, pattern));
      col = mix(col, colorPrimary, smoothstep(0.55, 0.95, pattern) * 0.55);
      float crest = smoothstep(0.8, 0.98, pattern + ripple * 0.5);
      col = mix(col, colorSecondary, crest * 0.35);

      vec2 uv = gl_FragCoord.xy / u_resolution.xy;
      float vignette = smoothstep(1.2, 0.35, distance(uv, vec2(0.5)));
      col *= vignette * 0.8 + 0.15;
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1
  ]), gl.STATIC_DRAW);

  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const time = gl.getUniformLocation(program, 'u_time');
  const mouseUniform = gl.getUniformLocation(program, 'u_mouse');
  const mouseVelocity = gl.getUniformLocation(program, 'u_mouse_velocity');

  let width = 0;
  let height = 0;
  let running = true;
  let startTime = performance.now();
  const mouse = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, speed: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextWidth = Math.floor(window.innerWidth * dpr);
    const nextHeight = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      width = nextWidth;
      height = nextHeight;
      gl.viewport(0, 0, width, height);
    }
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', (event) => {
    const nextX = event.clientX / window.innerWidth;
    const nextY = 1 - (event.clientY / window.innerHeight);
    const deltaX = nextX - mouse.targetX;
    const deltaY = nextY - mouse.targetY;
    mouse.targetX = nextX;
    mouse.targetY = nextY;
    mouse.speed = Math.min(Math.hypot(deltaX, deltaY) * 15, 1);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) {
      startTime = performance.now();
      requestAnimationFrame(render);
    }
  });

  function render(now) {
    if (!running) return;
    mouse.x += (mouse.targetX - mouse.x) * 0.08;
    mouse.y += (mouse.targetY - mouse.y) * 0.08;
    mouse.speed *= 0.94;

    gl.uniform2f(resolution, width, height);
    gl.uniform1f(time, (now - startTime) * 0.001);
    gl.uniform2f(mouseUniform, mouse.x, mouse.y);
    gl.uniform1f(mouseVelocity, mouse.speed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  }

  resize();
  requestAnimationFrame(render);
})();
