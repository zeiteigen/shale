export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export type LogOutputFn = (level: LogLevel, ...args: any[]) => void;

export interface LoggerOptions {
  name?: string;
  prefix?: string;
  output?: LogOutputFn;
}

/**
 * Universal logger utility that automatically prepends the extension name before content.
 */
export class Logger {
  readonly name: string;
  private readonly customPrefix?: string;
  private readonly outputFn: LogOutputFn;

  constructor(nameOrOptions: string | LoggerOptions = "default") {
    if (typeof nameOrOptions === "string") {
      this.name = nameOrOptions;
      this.outputFn = (level, ...args) => {
        console[level](...args);
      };
    } else {
      this.name = nameOrOptions.name || "default";
      this.customPrefix = nameOrOptions.prefix;
      this.outputFn =
        nameOrOptions.output ||
        ((level, ...args) => {
          console[level](...args);
        });
    }
  }

  get prefix(): string {
    return this.customPrefix ?? `[${this.name}]`;
  }

  formatArgs(args: any[]): any[] {
    if (args.length === 0) {
      return [this.prefix];
    }

    const [first, ...rest] = args;
    if (typeof first === "string") {
      if (first.startsWith(this.prefix)) {
        return args;
      }
      return [`${this.prefix} ${first}`, ...rest];
    }

    return [this.prefix, ...args];
  }

  log(...args: any[]): void {
    this.outputFn("log", ...this.formatArgs(args));
  }

  info(...args: any[]): void {
    this.outputFn("info", ...this.formatArgs(args));
  }

  warn(...args: any[]): void {
    this.outputFn("warn", ...this.formatArgs(args));
  }

  error(...args: any[]): void {
    this.outputFn("error", ...this.formatArgs(args));
  }

  debug(...args: any[]): void {
    this.outputFn("debug", ...this.formatArgs(args));
  }

  child(childName: string): Logger {
    return new Logger({
      name: `${this.name}:${childName}`,
      output: this.outputFn,
    });
  }
}

export type LoggerProxy = Logger & ((...args: any[]) => void);

/**
 * Creates a dynamic proxy that delegates logger method calls and function invocations
 * to the currently active SDK logger.
 */
export function createLoggerProxy(getTargetLogger: () => Logger): LoggerProxy {
  const dummyFn = (...args: any[]) => getTargetLogger().log(...args);
  return new Proxy(dummyFn, {
    get(_target, prop, receiver) {
      const active = getTargetLogger();
      const val = Reflect.get(active, prop, receiver);
      return typeof val === "function" ? val.bind(active) : val;
    },
    apply(_target, _thisArg, argArray) {
      return getTargetLogger().log(...argArray);
    },
  }) as unknown as LoggerProxy;
}

export default Logger;
