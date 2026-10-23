import { describe, expect, it } from 'vitest'

import { isTrustedCompactImageSrc } from './comment-markdown-element-renderers'

describe('isTrustedCompactImageSrc', () => {
  it('trusts the provider CDN and the long-standing schemes', () => {
    expect(
      isTrustedCompactImageSrc(
        'https://maas-log-prod.cn-wlcb.ufileos.com/a/b.png?UCloudPublicKey=x&Signature=y'
      )
    ).toBe(true)
    expect(isTrustedCompactImageSrc('data:image/png;base64,iVBOR')).toBe(true)
    expect(isTrustedCompactImageSrc('blob:abc')).toBe(true)
  })

  it('keeps every other host a link, and malformed input false', () => {
    expect(isTrustedCompactImageSrc('https://evil.example.com/pixel.png')).toBe(false)
    expect(isTrustedCompactImageSrc('http://maas-log-prod.cn-wlcb.ufileos.com/a.png')).toBe(false)
    expect(isTrustedCompactImageSrc(undefined)).toBe(false)
    expect(isTrustedCompactImageSrc('not a url')).toBe(false)
  })
})
