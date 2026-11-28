// The host's environment policy, as a driver applies it to the environment it
// forwards itself (an instance's `environment`, or a variable it reads for an
// in-process SDK). Drivers strip nothing on their own: the host's
// `envPolicy.stripAmbient` is the one list of variables kept from agents.

/** True when `name` matches an `envPolicy.stripAmbient` entry: an exact name, or a prefix ending in `*`. */
export function strippedByHost(name: string, stripAmbient: readonly string[]): boolean {
  return stripAmbient.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry));
}

/** `environment` without the variables the host's `envPolicy.stripAmbient` names. */
export function withoutHostStripped(environment: { readonly [name: string]: string }, stripAmbient: readonly string[]): { [name: string]: string } {
  const kept: { [name: string]: string } = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!strippedByHost(name, stripAmbient)) kept[name] = value;
  }
  return kept;
}
