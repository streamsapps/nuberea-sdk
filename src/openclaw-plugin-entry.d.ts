// Type stub for the host-provided openclaw module.
// At runtime this is resolved by the OpenClaw gateway; it is not in node_modules.
declare module 'openclaw/plugin-sdk/plugin-entry' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(api: any): void;
  }): unknown;
}
