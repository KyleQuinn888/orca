// The attachment mapping a pasted image rides into session/send: shape-locked
// against the installed CLI's strict discriminatedUnion (kind image accepts
// filename/mimeType/sizeBytes?/dataBase64?/localPath? and nothing else).

import { describe, expect, it } from 'vitest'
import { zcodePromptAttachments } from './zcode-structured-turns'

describe('zcodePromptAttachments', () => {
  it('maps an image-ref with a path to a localPath attachment', () => {
    expect(
      zcodePromptAttachments([
        { type: 'text', text: 'look' },
        {
          type: 'image-ref',
          path: 'C:\\tmp\\orca-paste-123-abc.png'
        }
      ])
    ).toEqual([
      {
        kind: 'image',
        filename: 'orca-paste-123-abc.png',
        mimeType: 'image/png',
        localPath: 'C:\\tmp\\orca-paste-123-abc.png'
      }
    ])
  })

  it('maps a data: URL image-ref to a dataBase64 attachment', () => {
    expect(
      zcodePromptAttachments([{ type: 'image-ref', url: 'data:image/jpeg;base64,QUJD' }])
    ).toEqual([
      { kind: 'image', filename: 'pasted.jpg', mimeType: 'image/jpeg', dataBase64: 'QUJD' }
    ])
  })

  it('derives jpg and webp mime types from the filename', () => {
    expect(
      zcodePromptAttachments([
        { type: 'image-ref', path: '/tmp/a.jpg' },
        { type: 'image-ref', path: '/tmp/b.webp' }
      ])
    ).toEqual([
      { kind: 'image', filename: 'a.jpg', mimeType: 'image/jpeg', localPath: '/tmp/a.jpg' },
      { kind: 'image', filename: 'b.webp', mimeType: 'image/webp', localPath: '/tmp/b.webp' }
    ])
  })

  it('drops text blocks and empty image refs instead of sending junk', () => {
    expect(
      zcodePromptAttachments([
        { type: 'text', text: '[Image #1]' },
        { type: 'image-ref' },
        { type: 'image-ref', url: 'https://example.com/cat.png' }
      ])
    ).toEqual([])
  })

  it('classifies .jpeg as image/jpeg', () => {
    expect(zcodePromptAttachments([{ type: 'image-ref', path: '/tmp/photo.jpeg' }])).toEqual([
      {
        kind: 'image',
        filename: 'photo.jpeg',
        mimeType: 'image/jpeg',
        localPath: '/tmp/photo.jpeg'
      }
    ])
  })

  it('drops non-image, non-base64, empty, and non-lowercase-scheme data URLs', () => {
    expect(
      zcodePromptAttachments([
        { type: 'image-ref', url: 'data:text/plain;base64,QUJD' },
        { type: 'image-ref', url: 'data:image/png,QUJD' },
        { type: 'image-ref', url: 'data:image/png;base64,' },
        // Orca's composer only ever emits lowercase data URLs; anything else is
        // not vouched for, so it drops rather than guesses at the encoding.
        { type: 'image-ref', url: 'DATA:IMAGE/PNG;BASE64,QUJD' }
      ])
    ).toEqual([])
  })
})
