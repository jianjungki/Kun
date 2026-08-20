import type { ComputerUseCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { withToolBoundary } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

export type ComputerUseBackend = {
  ready(): Promise<{ available: boolean; reason?: string }>
  screenshot(): Promise<{ mimeType: string; data: string; width: number; height: number }>
  move(x: number, y: number): Promise<void>
  click(input: { x?: number; y?: number; button: 'left' | 'right' | 'middle'; count: 1 | 2 }): Promise<void>
  type(text: string): Promise<void>
  key(keys: string[]): Promise<void>
}

type ComputerUseProviderOptions = {
  backend?: ComputerUseBackend
}

export type ComputerUseToolProviderBundle = {
  providers: CapabilityToolProvider[]
  available: boolean
  reason?: string
}

export async function buildComputerUseToolProviders(
  config: ComputerUseCapabilityConfig | undefined,
  options: ComputerUseProviderOptions = {}
): Promise<ComputerUseToolProviderBundle> {
  if (!config?.enabled) return { providers: [], available: false, reason: 'disabled by config' }
  const backend = options.backend ?? new NutComputerUseBackend(config)
  const availability = await backend.ready()
  const provider: CapabilityToolProvider = {
    id: 'computer-use',
    kind: 'computer-use',
    enabled: true,
    available: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
    tools: availability.available ? createComputerUseTools(backend, config.actionDelayMs) : []
  }
  return {
    providers: [provider],
    available: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {})
  }
}

function createComputerUseTools(backend: ComputerUseBackend, actionDelayMs: number) {
  return [
    LocalToolHost.defineTool({
      name: 'computer_screenshot',
      description: 'Capture the host display and return a bounded PNG image plus its action coordinate space.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      policy: 'on-request',
      execute: (_args, context) => withToolBoundary(async () => {
        assertNotAborted(context)
        return { output: await backend.screenshot() }
      })
    }),
    LocalToolHost.defineTool({
      name: 'computer_move',
      description: 'Move the host pointer to screenshot-space coordinates.',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } },
        required: ['x', 'y'],
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => computerAction(context, actionDelayMs, async () => {
        const x = nonNegativeNumber(args.x, 'x')
        const y = nonNegativeNumber(args.y, 'y')
        await backend.move(x, y)
        return { moved: true, x, y }
      })
    }),
    LocalToolHost.defineTool({
      name: 'computer_click',
      description: 'Click the host pointer, optionally moving first to screenshot-space coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', minimum: 0 },
          y: { type: 'number', minimum: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'integer', enum: [1, 2] }
        },
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => computerAction(context, actionDelayMs, async () => {
        const x = optionalNonNegativeNumber(args.x, 'x')
        const y = optionalNonNegativeNumber(args.y, 'y')
        if ((x === undefined) !== (y === undefined)) throw new Error('x and y must be provided together')
        const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
        const count = args.count === 2 ? 2 : 1
        await backend.click({ x, y, button, count })
        return { clicked: true, button, count, x, y }
      })
    }),
    LocalToolHost.defineTool({
      name: 'computer_type',
      description: 'Type text into the currently focused host application.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => computerAction(context, actionDelayMs, async () => {
        if (typeof args.text !== 'string') throw new Error('text is required')
        await backend.type(args.text)
        return { typed: true, characters: args.text.length }
      })
    }),
    LocalToolHost.defineTool({
      name: 'computer_key',
      description: 'Press a host keyboard shortcut using key names such as ctrl, shift, enter, or a-z.',
      inputSchema: {
        type: 'object',
        properties: { keys: { type: 'array', minItems: 1, items: { type: 'string' } } },
        required: ['keys'],
        additionalProperties: false
      },
      policy: 'on-request',
      execute: (args, context) => computerAction(context, actionDelayMs, async () => {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
          : []
        if (keys.length === 0) throw new Error('keys must contain at least one key name')
        await backend.key(keys)
        return { pressed: keys }
      })
    })
  ]
}

class NutComputerUseBackend implements ComputerUseBackend {
  private nut?: NutApi
  private jimp?: JimpApi
  private reason?: string
  private logicalSize?: { width: number; height: number }
  private displaySize?: { width: number; height: number }

  constructor(private readonly config: ComputerUseCapabilityConfig) {}

  async ready(): Promise<{ available: boolean; reason?: string }> {
    if (!this.nut && !this.reason) {
      const [nut, jimp] = await Promise.all([
        optionalImport<NutApi>('@computer-use/nut-js'),
        optionalImport<JimpApi>('jimp')
      ])
      if (!nut?.screen?.grab) this.reason = '@computer-use/nut-js is not installed for this platform'
      else if (!jimp?.Jimp?.fromBitmap) this.reason = 'jimp is not installed for screenshot conversion'
      else {
        this.nut = nut
        this.jimp = jimp
        if (this.nut.keyboard.config) this.nut.keyboard.config.autoDelayMs = 0
      }
    }
    return this.nut && this.jimp ? { available: true } : { available: false, reason: this.reason ?? 'computer use backend is unavailable' }
  }

  async screenshot(): Promise<{ mimeType: string; data: string; width: number; height: number }> {
    const nut = this.requireNut()
    const frame = await (await nut.screen.grab()).toRGB()
    const densityX = frame.pixelDensity?.scaleX || 1
    const densityY = frame.pixelDensity?.scaleY || 1
    this.logicalSize = {
      width: Math.max(1, Math.round(frame.width / densityX)),
      height: Math.max(1, Math.round(frame.height / densityY))
    }
    this.displaySize = fitSize(this.logicalSize.width, this.logicalSize.height, this.config.maxScreenshotWidth, this.config.maxScreenshotHeight)
    const image = await this.jimp!.Jimp.fromBitmap({
      width: frame.width,
      height: frame.height,
      data: Buffer.from(frame.data)
    })
    const output = await image.resize({ w: this.displaySize.width, h: this.displaySize.height }).getBuffer('image/png')
    return { mimeType: 'image/png', data: output.toString('base64'), ...this.displaySize }
  }

  async move(x: number, y: number): Promise<void> {
    const nut = this.requireNut()
    const point = await this.logicalPoint(x, y)
    await nut.mouse.move(nut.straightTo(new nut.Point(point.x, point.y)))
  }

  async click(input: { x?: number; y?: number; button: 'left' | 'right' | 'middle'; count: 1 | 2 }): Promise<void> {
    const nut = this.requireNut()
    if (input.x !== undefined && input.y !== undefined) await this.move(input.x, input.y)
    const button = input.button === 'right' ? nut.Button.RIGHT : input.button === 'middle' ? nut.Button.MIDDLE : nut.Button.LEFT
    if (input.count === 2) await nut.mouse.doubleClick(button)
    else await nut.mouse.click(button)
  }

  async type(text: string): Promise<void> {
    await this.requireNut().keyboard.type(text)
  }

  async key(keys: string[]): Promise<void> {
    const nut = this.requireNut()
    const resolved = keys.map((key) => resolveNutKey(nut.Key, key))
    await nut.keyboard.pressKey(...resolved)
    await nut.keyboard.releaseKey(...resolved.reverse())
  }

  private requireNut(): NutApi {
    if (!this.nut) throw new Error(this.reason ?? 'computer use backend is unavailable')
    return this.nut
  }

  private async logicalPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    if (!this.logicalSize || !this.displaySize) await this.screenshot()
    const logical = this.logicalSize!
    const display = this.displaySize!
    return {
      x: clamp(Math.round(x * logical.width / display.width), 0, logical.width - 1),
      y: clamp(Math.round(y * logical.height / display.height), 0, logical.height - 1)
    }
  }
}

type NutApi = {
  screen: { grab(): Promise<{ toRGB(): Promise<{ data: ArrayBufferLike; width: number; height: number; pixelDensity?: { scaleX?: number; scaleY?: number } }> }> }
  mouse: {
    move(target: unknown): Promise<unknown>
    click(button: unknown): Promise<unknown>
    doubleClick(button: unknown): Promise<unknown>
  }
  keyboard: {
    type(text: string): Promise<unknown>
    pressKey(...keys: unknown[]): Promise<unknown>
    releaseKey(...keys: unknown[]): Promise<unknown>
    config?: { autoDelayMs: number }
  }
  Button: { LEFT: unknown; RIGHT: unknown; MIDDLE: unknown }
  Key: Record<string, unknown>
  Point: new (x: number, y: number) => unknown
  straightTo(point: unknown): unknown
}

type JimpApi = {
  Jimp: {
    fromBitmap(input: { width: number; height: number; data: Buffer }): Promise<{
      resize(input: { w: number; h: number }): { getBuffer(mime: string): Promise<Buffer> }
    }>
  }
}

async function optionalImport<T>(specifier: string): Promise<T | undefined> {
  try {
    const namespace = await import(/* @vite-ignore */ specifier) as Record<string, unknown>
    const defaults = namespace.default && typeof namespace.default === 'object'
      ? namespace.default as Record<string, unknown>
      : {}
    return { ...defaults, ...namespace } as T
  } catch {
    return undefined
  }
}

function resolveNutKey(table: Record<string, unknown>, raw: string): unknown {
  const aliases: Record<string, string> = {
    ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt',
    enter: 'Enter', return: 'Enter', esc: 'Escape', cmd: 'LeftCmd', command: 'LeftCmd',
    meta: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper', space: 'Space',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', tab: 'Tab', backspace: 'Backspace'
  }
  const name = aliases[raw.trim().toLowerCase()] ?? raw.trim()
  const found = Object.entries(table).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  if (found === undefined) throw new Error(`unsupported key: ${raw}`)
  return found
}

async function computerAction(
  context: ToolHostContext,
  delayMs: number,
  run: () => Promise<unknown>
): Promise<{ output: unknown; isError?: boolean }> {
  return withToolBoundary(async () => {
    assertNotAborted(context)
    const output = await run()
    if (delayMs > 0) await delay(delayMs, context.abortSignal)
    return { output }
  })
}

function assertNotAborted(context: ToolHostContext): void {
  if (context.abortSignal.aborted) throw new Error('computer use action aborted')
}

function fitSize(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`)
  return value
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value, field)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('computer use action aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('computer use action aborted'))
    }, { once: true })
  })
}
