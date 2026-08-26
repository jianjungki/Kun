import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export type ResolvedNetworkAddress = {
  address: string
  family: number
}

export type NetworkAddressResolver = (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>

const defaultResolver: NetworkAddressResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true })

const blockedIpv4Addresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4')
}
const blockedIpv6Addresses = new BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0.0.0.0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6')
}

export async function assertPublicNetworkUrl(
  url: URL,
  resolver: NetworkAddressResolver = defaultResolver
): Promise<void> {
  await resolvePublicNetworkAddresses(url, resolver)
}

export async function resolvePublicNetworkAddresses(
  url: URL,
  resolver: NetworkAddressResolver = defaultResolver
): Promise<readonly ResolvedNetworkAddress[]> {
  const hostname = normalizeNetworkHostname(url.hostname)
  if (isPrivateNetworkHost(hostname)) {
    throw new Error(`private or local network targets are not allowed: ${hostname}`)
  }
  const literalFamily = isIP(hostname)
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }]
  }

  const addresses = (await resolver(hostname)).map((entry) => ({
    address: normalizeNetworkHostname(entry.address),
    family: isIP(normalizeNetworkHostname(entry.address))
  })).filter((entry) => entry.family === 4 || entry.family === 6)
  if (addresses.length === 0) throw new Error(`hostname did not resolve: ${hostname}`)
  const blocked = addresses.find((entry) => isPrivateNetworkHost(entry.address))
  if (blocked) {
    throw new Error(`hostname resolves to a private or local network address: ${hostname} -> ${blocked.address}`)
  }
  return addresses
}

export function normalizeNetworkHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
}

export function isPrivateNetworkHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  const family = isIP(hostname)
  if (family === 4) return isPrivateIpv4(hostname)
  if (family === 6) return isPrivateIpv6(hostname)
  return false
}

function isPrivateIpv4(address: string): boolean {
  return blockedIpv4Addresses.check(address, 'ipv4')
}

function isPrivateIpv6(address: string): boolean {
  return blockedIpv6Addresses.check(address, 'ipv6')
}
