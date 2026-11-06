/** Just enough of semver for the peer ranges in package.json: `~x.y.z` alternatives joined by `||`. */
const parse = (v: string): number[] => v.replace(/^~/u, '').split('-')[0]!.split('.').map(Number)

/**
 * @param version - e.g. 4.0.5.
 * @param range - e.g. `~4.0.5 || ~4.1.0`.
 * @returns whether a tilde alternative accepts it (same major.minor, patch at least).
 */
export function satisfies(version: string, range: string): boolean {
  const [ma, mi, pa] = parse(version)
  return range.split('||').map(r => r.trim()).some((r) => {
    if (!r.startsWith('~')) throw new Error(`unsupported range ${r}`)
    const [ra, ri, rp] = parse(r)
    return ma === ra && mi === ri && pa! >= rp!
  })
}
