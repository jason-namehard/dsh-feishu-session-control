import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import {
  packageNameFromModule,
  parseExactPackageSpec,
  purposeForPackage,
  readManagedDisabledOverrides,
  replaceManagedDisabledOverrides,
} from '../src/plugin-manager/index.js'

describe('dsh plugin manager safety helpers', () => {
  it('accepts only exact registry package versions', () => {
    expect(parseExactPackageSpec('@scope/plugin@1.2.3')).toEqual({
      spec: '@scope/plugin@1.2.3',
      packageName: '@scope/plugin',
      version: '1.2.3',
    })
    expect(parseExactPackageSpec('plugin@1.2.3-beta.1')).toEqual({
      spec: 'plugin@1.2.3-beta.1',
      packageName: 'plugin',
      version: '1.2.3-beta.1',
    })
    expect(parseExactPackageSpec('plugin@latest')).toBeUndefined()
    expect(parseExactPackageSpec('plugin@^1.2.3')).toBeUndefined()
    expect(parseExactPackageSpec('file:E:/plugin')).toBeUndefined()
  })

  it('extracts package roots without treating cordis builtins as packages', () => {
    expect(packageNameFromModule('@scope/plugin/client')).toBe('@scope/plugin')
    expect(packageNameFromModule('plugin/subpath')).toBe('plugin')
    expect(packageNameFromModule('cordis:include')).toBeUndefined()
  })

  it('keeps managed disable entries isolated from user patch content', () => {
    const userPatch = '- id: user-row\n  disabled: false\n'
    const managed = replaceManagedDisabledOverrides(userPatch, [{ id: 'plugin-row', name: 'plugin', disabled: true }])
    expect(readManagedDisabledOverrides(managed)).toEqual([
      { id: 'plugin-row', name: 'plugin', disabled: true },
    ])
    expect(managed).toContain(userPatch.trim())
    const cleared = replaceManagedDisabledOverrides(managed, [])
    expect(cleared).toBe(userPatch)
  })

  it('restores an empty patch file after its last managed override is removed', () => {
    const managed = replaceManagedDisabledOverrides('[]\n', [{ id: 'row', disabled: true }])
    expect(readManagedDisabledOverrides(managed)).toEqual([{ id: 'row', disabled: true }])
    expect(replaceManagedDisabledOverrides(managed, [])).toBe('[]\n')
  })

  it('keeps the complete managed patch valid YAML', () => {
    const managed = replaceManagedDisabledOverrides('[]\n', [{ id: 'row', disabled: true }])
    const document = parseDocument(managed)
    expect(document.errors).toHaveLength(0)
    expect(document.toJS()).toEqual([{ id: 'row', disabled: true }])
  })

  it('uses declared Chinese purpose text before the fallback catalogue', () => {
    expect(purposeForPackage('unknown', { dsh: { description: { zh: '自定义说明' } } })).toBe('自定义说明。')
    expect(purposeForPackage('dsh-hot-installer')).toContain('热加载')
    expect(purposeForPackage('unknown')).toContain('用途')
  })
})
