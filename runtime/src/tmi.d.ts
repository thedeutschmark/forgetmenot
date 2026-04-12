declare module "tmi.js" {
  interface ClientOptions {
    options?: { debug?: boolean };
    identity?: { username: string; password: string };
    channels?: string[];
    connection?: { reconnect?: boolean; secure?: boolean };
  }

  interface Userstate {
    id?: string;
    "user-id"?: string;
    username?: string;
    "display-name"?: string;
    mod?: boolean;
    badges?: Record<string, string>;
    "message-type"?: string;
  }

  class Client {
    constructor(options: ClientOptions);
    connect(): Promise<[string, number]>;
    disconnect(): Promise<[string, number]>;
    say(channel: string, message: string): Promise<[string]>;
    on(event: "connected", callback: (address: string, port: number) => void): void;
    on(event: "disconnected", callback: (reason: string) => void): void;
    on(event: "message", callback: (channel: string, userstate: Userstate, message: string, self: boolean) => void): void;
    on(event: "join", callback: (channel: string, username: string, self: boolean) => void): void;
    readyState(): string;
  }

  const _default: { Client: typeof Client };
  export = _default;
}
