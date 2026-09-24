import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runtime glue and WASM binaries must match the installed MediaPipe JS exactly.
const source = fileURLToPath(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url));
const target = fileURLToPath(new URL('../public/wasm/', import.meta.url));
cpSync(source, target, { recursive: true });
