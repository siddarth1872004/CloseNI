// This is our dummy file with a math bug
export function add(a: number, b: number) {
  return a - b; // BUG: Should be a + b
}

export function multiply(a: number, b: number) {
  return a * b;
}