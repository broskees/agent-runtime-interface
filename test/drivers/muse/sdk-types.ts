// Type-level proof that the driver's own description of the Muse SDK
// (src/drivers/muse/sdk.ts) matches the pinned SDK devDependency
// (@muse-code/sdk 1.4.25). `pnpm run typecheck` fails when either side
// drifts:
//
// - The SDK module is assignable to the driver's `MuseSdk`: its `Connection`
//   takes the driver's transport and has every member the driver calls, its
//   `MspError` carries `code`, `kind` and `data`, and `createUuidV7Mint` is
//   the minter the driver falls back to.
// - Sent: every params type the driver sends, with the `commandId` the
//   connection adds to a command, is assignable to the SDK's params type for
//   that method (`MspMethodMap`), and every method it calls is one the
//   stable surface lists.
// - Read: every result, notification and server request the SDK types for a
//   method the driver reads is assignable to the driver's view of it, so each
//   field the driver reads exists in the SDK's type with a compatible type.
//
// The fake host (fake-muse.ts) is typed by the SDK's wire types too, and
// frames.ts type-checks every frame either side wrote in every test.

import type * as MuseSdkModule from "@muse-code/sdk";
import type { MspMethodMap, MspNotificationMap, MspServerRequestMap } from "@muse-code/sdk/dist/src/msp.js";
import type { MuseCommandMethod, MuseConnection, MuseMethods, MuseNotifications, MuseSdk, MuseServerRequests } from "../../../src/drivers/muse/sdk.ts";

type SdkModule = typeof MuseSdkModule;

/** The SDK module is the driver's `MuseSdk`. */
export const sdkModuleFits: (module: SdkModule) => MuseSdk = (module) => module;

/** The SDK's `Connection`, member by member (its methods compare bivariantly, so each is also checked as a function). */
type SdkConnection = InstanceType<SdkModule["Connection"]>;
export const connectionFits: (connection: SdkConnection) => MuseConnection = (connection) => connection;
export const connectionMembers: {
  readonly mintCommandId: (connection: SdkConnection) => MuseConnection["mintCommandId"];
  readonly notify: (connection: SdkConnection) => MuseConnection["notify"];
  readonly onNotification: (connection: SdkConnection) => (handler: Parameters<MuseConnection["onNotification"]>[0]) => void;
  readonly onServerRequest: (connection: SdkConnection) => (handler: Parameters<MuseConnection["onServerRequest"]>[0]) => void;
  readonly close: (connection: SdkConnection) => MuseConnection["close"];
} = {
  mintCommandId: (connection) => () => connection.mintCommandId(),
  notify: (connection) => (method, params) => connection.notify(method, params),
  onNotification: (connection) => (handler) => connection.onNotification(handler),
  onServerRequest: (connection) => (handler) => connection.onServerRequest(handler),
  close: (connection) => () => connection.close(),
};

/** Every method the driver calls is listed in the SDK's stable method map. */
export const methodsListed: { readonly [M in keyof MuseMethods]: M extends keyof MspMethodMap ? true : never } = {
  initialize: true,
  "session/start": true,
  "session/resume": true,
  "session/read": true,
  "session/setModel": true,
  "session/setApprovalMode": true,
  "session/compact": true,
  "turn/start": true,
  "turn/steer": true,
  "turn/interrupt": true,
  "turn/unqueue": true,
  "approval/decide": true,
  "userInput/answer": true,
  "model/list": true,
  "usage/read": true,
};

type Listed<M> = M & keyof MspMethodMap;

/** What the driver puts on the wire for a method: a command gains its `commandId` from the connection. */
type Sent<M extends keyof MuseMethods> = M extends MuseCommandMethod ? MuseMethods[M]["params"] & { commandId: string } : MuseMethods[M]["params"];

type Accepted<M extends keyof MuseMethods> = Sent<M> extends MspMethodMap[Listed<M>]["params"] ? true : { readonly refused: M };
type Readable<M extends keyof MuseMethods> = MspMethodMap[Listed<M>]["result"] extends MuseMethods[M]["result"] ? true : { readonly unreadable: M };

/** Every params type the driver sends is one the SDK accepts. */
export const sentAccepted: { readonly [M in keyof MuseMethods]: true } = null as unknown as { readonly [M in keyof MuseMethods]: Accepted<M> };

/** Every result the SDK types is readable as the driver's view of it. */
export const resultsReadable: { readonly [M in keyof MuseMethods]: true } = null as unknown as { readonly [M in keyof MuseMethods]: Readable<M> };

type NotificationReadable<N extends keyof MuseNotifications> = N extends keyof MspNotificationMap ? (MspNotificationMap[N] extends MuseNotifications[N] ? true : { readonly unreadable: N }) : { readonly unlisted: N };

/** Every notification the driver reads is listed, and the SDK's params type is readable as the driver's view. */
export const notificationsReadable: { readonly [N in keyof MuseNotifications]: true } = null as unknown as { readonly [N in keyof MuseNotifications]: NotificationReadable<N> };

type RequestReadable<R extends keyof MuseServerRequests> = R extends keyof MspServerRequestMap ? (MspServerRequestMap[R]["params"] extends MuseServerRequests[R] ? true : { readonly unreadable: R }) : { readonly unlisted: R };

/** Every server request the driver answers is listed, and its params are readable as the driver's view; the driver's answer `{}` is the SDK's receipt. */
export const serverRequestsReadable: { readonly [R in keyof MuseServerRequests]: true } = null as unknown as { readonly [R in keyof MuseServerRequests]: RequestReadable<R> };
export const receiptFits: MspServerRequestMap["approval/request"]["result"] & MspServerRequestMap["userInput/request"]["result"] = {};
