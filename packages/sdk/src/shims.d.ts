/**
 * Build-time module shims — NOT shipped to consumers.
 *
 * This package typechecks and builds with zero node_modules installed, so the
 * peer dependencies are declared here with just enough shape for a strict
 * compile. `tsc` does not copy input .d.ts files to `dist/`, and the emitted
 * public declarations only reference names that exist in the real packages
 * (e.g. `React.ReactNode`), so consumers always resolve against their own
 * `react` / `react-native` types — never these.
 */

declare module "react" {
  export type ReactNode = unknown;
  // Loose on purpose: consumers see the real ReactElement from their own react.
  export type ReactElement = any;
  export interface Context<T> {
    Provider: any;
    Consumer: any;
  }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(context: Context<T>): T;
  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[]
  ): void;
  export function useState<S>(
    initialState: S | (() => S)
  ): [S, (value: S) => void];
  export function createElement(type: any, props?: any, ...children: any[]): any;
  // Just enough Component surface for a class-based error boundary. Loose on
  // purpose: consumers type against their own react.
  export class Component<P = {}, S = {}> {
    constructor(props: P);
    readonly props: P;
    state: S;
    setState(state: Partial<S>): void;
    render(): unknown;
  }
}

declare module "react-native" {
  export type AppStateStatus =
    | "active"
    | "background"
    | "inactive"
    | "unknown"
    | "extension";
  export interface NativeEventSubscription {
    remove(): void;
  }
  export const AppState: {
    addEventListener(
      type: "change",
      listener: (state: AppStateStatus) => void
    ): NativeEventSubscription;
  };
}

/**
 * `require` exists in every environment this package runs in (Metro, Node,
 * webpack CJS interop) but has no type without @types/node. Typed as possibly
 * undefined so call sites keep their `typeof require === "function"` guard.
 */
declare const require: undefined | ((moduleId: string) => unknown);

/**
 * Minimal global JSX namespace for the classic `React.createElement` runtime
 * used by provider.tsx. Consumers get the real JSX types from their own React.
 */
declare namespace JSX {
  type Element = any;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
