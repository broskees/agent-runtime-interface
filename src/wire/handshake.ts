// Version negotiation for `initialize` (proposal §17.5). The host sends its
// side of the handshake, the driver answers with its own, and both ends run
// `negotiateHandshake` on the two to reach the same result:
//
// - `ariVersion`: the contract versions must share their major version.
// - `grammarVersions`: each side's ascending `[min, max]` range of event
//   grammar versions; the connection uses the highest version both contain.
//   Ranges with no version in common refuse the connection.
// - `methodVersions`: per method, `{ major, minor }`. A method both sides list
//   with the same major is spoken at the lower minor, so a newer side never
//   sends what an older side cannot read. A method listed with different
//   majors is refused: calls to it reject with `unsupported`. A method the
//   host does not list is spoken at the driver's version; a method the driver
//   does not list does not exist on the connection. A method that needs a
//   helper (a stream's item notification, a delegated child's output and
//   exit) is refused when the helper is refused or missing, so a stream never
//   opens without the notifications that carry it. The core methods
//   (`initialize`, `stream/end`, `stream/cancel`) are the exception: no stream
//   could end or be stopped without them, so a driver that does not list one,
//   or a major mismatch on one, refuses the connection.
// - `persistenceVersion`: stored handles and journals must share their major
//   version; the connection uses the lower minor.
//
// Refusals are `protocol` call errors whose message names both sides' values.

import { callErrors } from "../errors.ts";
import type { Version } from "../generated/common.ts";
import type { Handshake } from "../generated/handshake.ts";
import { METHOD_HELPERS } from "./methods.ts";

export interface NegotiatedVersions {
  /** The host's and the driver's contract versions; their majors are equal. */
  readonly ariVersions: { readonly host: string; readonly driver: string };
  /** The event grammar version the connection uses. */
  readonly grammarVersion: number;
  /** The version each usable method is spoken at. */
  readonly methodVersions: { readonly [method: string]: Version };
  /**
   * Methods refused on this connection: both sides list them with different
   * major versions, or (`because`) a helper they need is refused, such as a
   * stream's item notification. Calls to them are refused.
   */
  readonly refusedMethods: { readonly [method: string]: RefusedMethod };
  /** The persistence version of stored handles and journals on this connection. */
  readonly persistenceVersion: Version;
}

/** Methods the connection cannot work without; a major mismatch on one refuses the connection. */
export const CORE_METHODS = ["initialize", "stream/end", "stream/cancel"] as const;

/**
 * Why a method is refused: the two sides' versions of it, or the helper it
 * needs (`because`) with that helper's versions, or no versions when the
 * driver does not list the helper at all.
 */
export type RefusedMethod =
  | { readonly host: Version; readonly driver: Version; readonly because?: string }
  | { readonly because: string; readonly host?: undefined; readonly driver?: undefined };

function contractMajor(version: string, side: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw callErrors.validation([{ message: `is not a semantic version: ${JSON.stringify(version)}`, path: [side, "ariVersion"] }], `The ${side}'s ariVersion is not a semantic version`);
  return Number(match[1]);
}

function checkRange(range: readonly number[], side: string): readonly [number, number] {
  const [min, max] = range;
  if (range.length !== 2 || !Number.isInteger(min) || !Number.isInteger(max) || min! < 1 || min! > max!) {
    throw callErrors.validation([{ message: "must be an ascending [min, max] pair of positive integers", path: [side, "grammarVersions"] }], `The ${side}'s grammarVersions is not an ascending range`);
  }
  return [min!, max!];
}

function rangeText(range: readonly number[]): string {
  return `[${range.join(", ")}]`;
}

function versionText(version: Version): string {
  return `${version.major}.${version.minor}`;
}

/** The highest event grammar version both ranges contain, or undefined when they do not overlap. */
export function negotiateGrammarVersion(host: readonly number[], driver: readonly number[]): number | undefined {
  const [hostMin, hostMax] = checkRange(host, "host");
  const [driverMin, driverMax] = checkRange(driver, "driver");
  const low = Math.max(hostMin, driverMin);
  const high = Math.min(hostMax, driverMax);
  return low <= high ? high : undefined;
}

/** Negotiates the three version axes, or throws a `protocol` call error naming both sides' values. */
export function negotiateHandshake(host: Handshake, driver: Handshake): NegotiatedVersions {
  const hostMajor = contractMajor(host.ariVersion, "host");
  const driverMajor = contractMajor(driver.ariVersion, "driver");
  if (hostMajor !== driverMajor) {
    throw callErrors.protocol(
      "ari_version_mismatch",
      `The ARI contract versions are incompatible: the host speaks ${host.ariVersion} and the driver speaks ${driver.ariVersion}`,
    );
  }

  const grammarVersion = negotiateGrammarVersion(host.grammarVersions, driver.grammarVersions);
  if (grammarVersion === undefined) {
    throw callErrors.protocol(
      "grammar_version_mismatch",
      `The event grammar version ranges do not overlap: the host speaks ${rangeText(host.grammarVersions)} and the driver speaks ${rangeText(driver.grammarVersions)}`,
    );
  }

  if (host.persistenceVersion.major !== driver.persistenceVersion.major) {
    throw callErrors.protocol(
      "persistence_version_mismatch",
      `The persistence versions are incompatible: the host stores ${versionText(host.persistenceVersion)} and the driver stores ${versionText(driver.persistenceVersion)}`,
    );
  }
  const persistenceVersion: Version = {
    major: driver.persistenceVersion.major,
    minor: Math.min(host.persistenceVersion.minor, driver.persistenceVersion.minor),
  };

  const methodVersions: { [method: string]: Version } = {};
  const refusedMethods: { [method: string]: RefusedMethod } = {};
  for (const [method, driverVersion] of Object.entries(driver.methodVersions)) {
    const hostVersion = host.methodVersions[method];
    if (hostVersion === undefined) {
      methodVersions[method] = { major: driverVersion.major, minor: driverVersion.minor };
    } else if (hostVersion.major !== driverVersion.major) {
      refusedMethods[method] = { host: { ...hostVersion }, driver: { ...driverVersion } };
    } else {
      methodVersions[method] = { major: driverVersion.major, minor: Math.min(hostVersion.minor, driverVersion.minor) };
    }
  }

  // A method whose stream item or process helper is refused or missing cannot work either.
  for (const [method, helpers] of Object.entries(METHOD_HELPERS)) {
    if (methodVersions[method] === undefined) continue;
    const unusableHelper = helpers.find((helper) => methodVersions[helper] === undefined);
    if (unusableHelper === undefined) continue;
    delete methodVersions[method];
    const helperRefusal = refusedMethods[unusableHelper];
    refusedMethods[method] =
      helperRefusal?.host === undefined ? { because: unusableHelper } : { host: helperRefusal.host, driver: helperRefusal.driver, because: unusableHelper };
  }

  for (const method of CORE_METHODS) {
    if (driver.methodVersions[method] === undefined) {
      throw callErrors.protocol("core_method_missing", `The driver does not list the wire method ${method}, and the connection cannot work without it`);
    }
    const refused = refusedMethods[method];
    if (refused?.host !== undefined) {
      throw callErrors.protocol(
        "core_method_version_mismatch",
        `The wire method ${method} is incompatible: the host speaks version ${versionText(refused.host)} and the driver speaks ${versionText(refused.driver)}, and the connection cannot work without it`,
      );
    }
  }

  return {
    ariVersions: { host: host.ariVersion, driver: driver.ariVersion },
    grammarVersion,
    methodVersions,
    refusedMethods,
    persistenceVersion,
  };
}

/** The `unsupported` error for a call to a method this connection refused or does not have. */
export function methodUnavailable(method: string, negotiated: NegotiatedVersions): Error {
  const refused = negotiated.refusedMethods[method];
  if (refused?.host === undefined && refused?.because !== undefined) {
    return callErrors.unsupported(method, `The wire method ${method} is unavailable because it needs ${refused.because}, which the driver does not list`);
  }
  if (refused?.host !== undefined) {
    const which = refused.because === undefined ? "" : ` because it needs ${refused.because}, of which`;
    return callErrors.unsupported(
      method,
      `The wire method ${method} is unavailable${which}: the host speaks version ${versionText(refused.host)} and the driver speaks ${versionText(refused.driver)}`,
    );
  }
  return callErrors.unsupported(method, `The wire method ${method} is not available on this connection`);
}
