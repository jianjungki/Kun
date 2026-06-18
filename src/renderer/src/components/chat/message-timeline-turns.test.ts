import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { groupTurns, groupTurnsWithReuse, sameTurnContent, stableTurnKey } from './message-timeline-turns'

describe('message timeline turns', () => {
  it('uses stable ids for user and assistant-only turns', () => {
    const blocks: ChatBlock[] = [
      { kind: 'assistant', id: 'assistant_intro', text: 'Welcome' },
      { kind: 'user', id: 'user_1', text: 'Hello' },
      { kind: 'assistant', id: 'assistant_1', text: 'Hi' }
    ]

    const turns = groupTurns(blocks)

    expect(stableTurnKey(turns[0], 0)).toBe('assistant_intro')
    expect(stableTurnKey(turns[1], 1)).toBe('user_1')
  })

  it('treats rebuilt turn arrays as the same content when block references are unchanged', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user_1', text: 'Hello' },
      { kind: 'assistant', id: 'assistant_1', text: 'Hi' }
    ]

    const first = groupTurns(blocks)[0]
    const second = groupTurns(blocks)[0]

    expect(first).not.toBe(second)
    expect(sameTurnContent(first, second)).toBe(true)
  })

  it('detects updates to a block inside an otherwise stable turn', () => {
    const firstBlocks: ChatBlock[] = [
      { kind: 'user', id: 'user_1', text: 'Hello' },
      { kind: 'assistant', id: 'assistant_1', text: 'Hi' }
    ]
    const nextBlocks: ChatBlock[] = [
      firstBlocks[0],
      { kind: 'assistant', id: 'assistant_1', text: 'Hi again' }
    ]

    expect(sameTurnContent(groupTurns(firstBlocks)[0], groupTurns(nextBlocks)[0])).toBe(false)
  })

  it('reuses unchanged turn objects while replacing only updated turns', () => {
    const user1: ChatBlock = { kind: 'user', id: 'user_1', text: 'Hello' }
    const assistant1: ChatBlock = { kind: 'assistant', id: 'assistant_1', text: 'Hi' }
    const user2: ChatBlock = { kind: 'user', id: 'user_2', text: 'Next' }
    const assistant2: ChatBlock = { kind: 'assistant', id: 'assistant_2', text: 'Working' }
    const first = groupTurns([user1, assistant1, user2, assistant2])
    const nextAssistant2: ChatBlock = { kind: 'assistant', id: 'assistant_2', text: 'Done' }

    const next = groupTurnsWithReuse([user1, assistant1, user2, nextAssistant2], first)

    expect(next[0]).toBe(first[0])
    expect(next[1]).not.toBe(first[1])
    expect(next[1]?.blocks[0]).toBe(nextAssistant2)
  })
})
