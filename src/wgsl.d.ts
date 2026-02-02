/**
 * TypeScript declarations for WGSL shader files
 * Allows importing .wgsl files with Vite's ?raw suffix
 */

declare module '*.wgsl' {
  const content: string;
  export default content;
}

declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
