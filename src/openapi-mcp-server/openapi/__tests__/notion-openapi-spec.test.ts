/**
 * Regression tests for the Notion OpenAPI spec as processed by OpenAPIToMCPConverter.
 *
 * These tests load the real scripts/notion-openapi.json from disk and run it through
 * the converter, asserting the end-to-end tool shape without mocking the spec.
 *
 * Issue #271: PATCH /v1/blocks/{id} used a catch-all `type: object` body property
 * that caused the generated tool to expose a bare `type` parameter, making it
 * impossible for LLM clients to know which block type they were updating.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { OpenAPIToMCPConverter } from '../parser'

// Resolve the spec relative to the repo root so this test works from any cwd.
const SPEC_PATH = path.resolve(__dirname, '../../../../scripts/notion-openapi.json')

function loadSpec() {
  const raw = fs.readFileSync(SPEC_PATH, 'utf-8')
  return JSON.parse(raw)
}

describe('Notion OpenAPI spec → MCP tool shape', () => {
  describe('PATCH /v1/blocks/{block_id} — regression for issue #271', () => {
    let method: ReturnType<InstanceType<typeof OpenAPIToMCPConverter>['convertToMCPTools']>['tools'][string]['methods'][number]
    let defs: Record<string, any>

    beforeAll(() => {
      const spec = loadSpec()
      const converter = new OpenAPIToMCPConverter(spec)
      const { tools } = converter.convertToMCPTools()
      method = tools.API.methods.find((m) => m.name === 'update-a-block')!
      defs = method.inputSchema.$defs as Record<string, any>
    })

    it('spec file exists and is valid JSON', () => {
      expect(() => loadSpec()).not.toThrow()
    })

    it('converts to an API-update-a-block tool', () => {
      expect(method).toBeDefined()
    })

    it('does NOT expose a bare `type` property at the top level (regression #271)', () => {
      const topLevelProps = Object.keys(method.inputSchema.properties ?? {})
      expect(topLevelProps).not.toContain('type')
    })

    it('exposes a typed `body` parameter (block-type discriminated union)', () => {
      const topLevelProps = Object.keys(method.inputSchema.properties ?? {})
      expect(topLevelProps).toContain('body')
    })

    it('body resolves to updateBlockRequest via anyOf (schema + string fallback)', () => {
      const body = method.inputSchema.properties!.body as any
      // Parser wraps non-object body in anyOf: [schema, {type:'string'}] for LLM string-fallback.
      expect(body).toHaveProperty('anyOf')
      const refs = (body.anyOf as any[]).map((e: any) => e.$ref).filter(Boolean)
      expect(refs).toContain('#/$defs/updateBlockRequest')
    })

    it('updateBlockRequest is a oneOf over all supported block-update variants', () => {
      expect(defs).toHaveProperty('updateBlockRequest')
      const updateBlockRequest = defs.updateBlockRequest
      expect(updateBlockRequest).toHaveProperty('oneOf')
      const variantRefs = updateBlockRequest.oneOf.map((e: any) => e.$ref).filter(Boolean) as string[]

      // All text-bearing block types must be present.
      const required = [
        'updateParagraphBlockRequest',
        'updateHeading1BlockRequest',
        'updateHeading2BlockRequest',
        'updateHeading3BlockRequest',
        'updateBulletedListItemBlockRequest',
        'updateNumberedListItemBlockRequest',
        'updateToDoBlockRequest',
        'updateToggleBlockRequest',
        'updateCodeBlockRequest',
        'updateCalloutBlockRequest',
        'updateQuoteBlockRequest',
        'updateEquationBlockRequest',
      ]
      for (const name of required) {
        expect(variantRefs).toContain(`#/$defs/${name}`)
      }

      // Media block types (stretch goal, also required).
      const media = [
        'updateEmbedBlockRequest',
        'updateBookmarkBlockRequest',
        'updateImageBlockRequest',
        'updateVideoBlockRequest',
        'updateFileBlockRequest',
        'updatePdfBlockRequest',
        'updateAudioBlockRequest',
      ]
      for (const name of media) {
        expect(variantRefs).toContain(`#/$defs/${name}`)
      }

      // Archive-only variant for block types with no editable content (divider, etc.).
      expect(variantRefs).toContain('#/$defs/updateBlockArchivedRequest')
    })

    it('each text-bearing variant exposes rich_text within its block-type object', () => {
      const textBearing: Array<[string, string]> = [
        ['updateParagraphBlockRequest', 'paragraph'],
        ['updateBulletedListItemBlockRequest', 'bulleted_list_item'],
        ['updateNumberedListItemBlockRequest', 'numbered_list_item'],
        ['updateToDoBlockRequest', 'to_do'],
        ['updateToggleBlockRequest', 'toggle'],
        ['updateCalloutBlockRequest', 'callout'],
        ['updateQuoteBlockRequest', 'quote'],
        ['updateHeading1BlockRequest', 'heading_1'],
        ['updateHeading2BlockRequest', 'heading_2'],
        ['updateHeading3BlockRequest', 'heading_3'],
        ['updateCodeBlockRequest', 'code'],
      ]

      for (const [schemaName, blockKey] of textBearing) {
        const def = defs[schemaName]
        expect(def, `${schemaName} should exist in $defs`).toBeDefined()
        const blockProp = def.properties?.[blockKey]
        expect(blockProp, `${schemaName}.${blockKey} should exist`).toBeDefined()
        expect(
          blockProp.properties?.rich_text,
          `${schemaName}.${blockKey}.rich_text should exist`,
        ).toBeDefined()
      }
    })

    it('to_do variant exposes a `checked` field', () => {
      const toDo = defs.updateToDoBlockRequest
      expect(toDo.properties.to_do.properties).toHaveProperty('checked')
    })

    it('code variant exposes a `language` field', () => {
      const code = defs.updateCodeBlockRequest
      expect(code.properties.code.properties).toHaveProperty('language')
    })

    it('callout variant exposes an `icon` field', () => {
      const callout = defs.updateCalloutBlockRequest
      expect(callout.properties.callout.properties).toHaveProperty('icon')
    })

    it('media variants expose external + caption fields', () => {
      const mediaVariants: Array<[string, string]> = [
        ['updateImageBlockRequest', 'image'],
        ['updateVideoBlockRequest', 'video'],
        ['updateFileBlockRequest', 'file'],
        ['updatePdfBlockRequest', 'pdf'],
        ['updateAudioBlockRequest', 'audio'],
      ]
      for (const [schemaName, blockKey] of mediaVariants) {
        const def = defs[schemaName]
        expect(def, `${schemaName} should exist`).toBeDefined()
        const blockProp = def.properties?.[blockKey]
        expect(blockProp?.properties, `${schemaName}.${blockKey}.properties`).toHaveProperty('external')
        expect(blockProp?.properties, `${schemaName}.${blockKey}.properties`).toHaveProperty('caption')
      }
    })

    it('all variants include an optional `archived` field', () => {
      const variantSchemaNames = [
        'updateParagraphBlockRequest',
        'updateHeading1BlockRequest',
        'updateHeading2BlockRequest',
        'updateHeading3BlockRequest',
        'updateBulletedListItemBlockRequest',
        'updateNumberedListItemBlockRequest',
        'updateToDoBlockRequest',
        'updateToggleBlockRequest',
        'updateCodeBlockRequest',
        'updateCalloutBlockRequest',
        'updateQuoteBlockRequest',
        'updateEquationBlockRequest',
        'updateEmbedBlockRequest',
        'updateBookmarkBlockRequest',
        'updateImageBlockRequest',
        'updateVideoBlockRequest',
        'updateFileBlockRequest',
        'updatePdfBlockRequest',
        'updateAudioBlockRequest',
        'updateBlockArchivedRequest',
      ]

      for (const name of variantSchemaNames) {
        const def = defs[name]
        expect(def, `${name} should exist`).toBeDefined()
        expect(def.properties, `${name} should have properties`).toHaveProperty('archived')
      }
    })
  })
})
