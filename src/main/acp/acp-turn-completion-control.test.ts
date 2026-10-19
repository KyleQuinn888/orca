// Control for the zcode subscriber-path test: the same subscription over the
// ACP rig, proving the test expectation itself is sound before zcode diffing.
import { describe, expect, it, vi } from 'vitest'

import { openAttachedHostRig, promptIdOf, send } from './acp-structured-host.test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { replyChunk } from './acp-structured-adapter.test-support'

describe('ACP turn completion publication (control)', () => {
  it('emits a turn completion to subscribers when a reply ends the turn', async () => {
    const { rig, host } = await openAttachedHostRig()
    const events: unknown[] = []
    const unsubscribe = host.subscribeTurnCompletions({
      id: 'acp-control',
      emit: (event) => {
        events.push(event)
      }
    })
    try {
      await send(host, 'hello')
      const prompt = await rig.frame('session/prompt')
      rig.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'hi'))
      // The turn ends when Grok answers the prompt request.
      rig.child().agent.reply(prompt, {})
      await vi.waitFor(
        () => {
          expect(events.length).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
    } finally {
      unsubscribe()
      await host.close(SESSION, 'user-close')
    }
  })
})
