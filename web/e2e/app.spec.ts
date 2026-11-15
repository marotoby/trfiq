import { expect, test, type Page } from '@playwright/test'

// Collect console errors; any error fails the test.
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

/** Count distinct colours in a screenshot of `selector`, decoded in the page itself. */
async function distinctColours(page: Page, selector: string): Promise<number> {
  const png = await page.locator(selector).screenshot()
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const seen = new Set<number>()
    for (let i = 0; i < d.length; i += 4 * 7) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
    return seen.size
  }, png.toString('base64'))
}

test('recording list loads from the index, searches and shows statuses', async ({ page }) => {
  const errors = watchErrors(page)
  const t0 = Date.now()
  const listResp = page.waitForResponse((r) => r.url().includes('/api/recordings'))
  await page.goto('/')
  const resp = await listResp
  expect(resp.ok()).toBeTruthy()
  // Budget: recording list < 300 ms (served from the index).
  expect(Date.now() - t0).toBeLessThan(3000)
  const timing = (await resp.request().timing()).responseEnd
  expect(timing).toBeLessThan(300)

  await expect(page.locator('.tr')).not.toHaveCount(0)
  await expect(page.locator('.status-broken').first()).toBeVisible()
  await expect(page.locator('.status-needs_meta').first()).toBeVisible()
  await expect(page.locator('.source.state-ok')).not.toHaveCount(0)

  await page.locator('.search').fill('chirp')
  await expect(page).toHaveURL(/q=chirp/)
  await expect(page.locator('.tr')).toHaveCount(await page.locator('.source').count())
  await expect(page.locator('.tr').first()).toContainText('chirps')
  expect(errors).toEqual([])
})

test('viewer renders the overview within budget and keeps state in the URL', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?q=chirps')
  const row = page.locator('.tr', { hasText: 'chirps' }).first()
  await expect(row).toBeVisible()

  const t0 = Date.now()
  await row.click()
  await expect(page.locator('.statusbar')).toContainText('strided overview', { timeout: 5000 })
  // Budget: first overview < 2 s.
  expect(Date.now() - t0).toBeLessThan(2000)

  // The spectrogram actually drew something (a blank canvas has ~1 colour).
  await page.waitForTimeout(100)
  expect(await distinctColours(page, '.spectrogram')).toBeGreaterThan(50)

  // Cursor readout.
  const box = (await page.locator('.spectrogram canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.readout')).toContainText('MHz')
  await expect(page.locator('.readout')).toContainText('dB')

  // Colormap change goes to the URL; it's applied in the shader with no refetch.
  let refetched = false
  page.on('request', (r) => r.url().includes('/overview') && (refetched = true))
  await page.getByLabel('Colormap').selectOption('viridis')
  await expect(page).toHaveURL(/cmap=viridis/)
  expect(refetched).toBe(false)

  // Zoom → view saved to the URL (debounced) → reload restores it.
  await page.mouse.wheel(0, -400)
  await expect(page).toHaveURL(/v=/)
  const url = page.url()
  await page.reload()
  await expect(page.locator('.statusbar')).toContainText('strided overview')
  expect(page.url()).toBe(url)

  // Keyboard reset clears the view param.
  await page.locator('.spectrogram').focus()
  await page.keyboard.press('0')
  await expect(page).not.toHaveURL(/v=/)
  expect(errors).toEqual([])
})

test('broken and raw recordings explain themselves', async ({ page }) => {
  await page.goto('/?status=broken')
  await page.locator('.tr').first().click()
  await expect(page.locator('.plot-card')).toContainText('missing .sigmf-meta')
})

test('box zoom zooms to the dragged region and Back restores the view', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?q=chirps')
  await page.locator('.tr').first().click()
  await expect(page.locator('.statusbar')).toContainText('strided overview')
  const back = page.getByRole('button', { name: /Previous view/ })
  await expect(back).toBeDisabled()

  const box = (await page.locator('.spectrogram canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 })
  await page.mouse.up()
  // Box from 25% to 50% on both axes → that region fills the view.
  await expect(page).toHaveURL(/v=0\.25(,|%2C)0\.5(,|%2C)0\.25(,|%2C)0\.5/)

  await expect(back).toBeEnabled()
  await back.click()
  await expect(page).not.toHaveURL(/v=/)
  expect(errors).toEqual([])
})

test('annotations are listed, filterable, and zoom the plot when clicked', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?q=ism_433')
  await page.locator('.tr').first().click()
  await expect(page.locator('.statusbar')).toContainText('strided overview')

  const items = page.locator('.ann-item')
  await expect(items).toHaveCount(19)
  await expect(page.locator('.label-chip')).toHaveCount(5)

  // Hide one label → its items disappear from the list.
  await page.locator('.label-chip', { hasText: 'CW' }).click()
  await expect(items).toHaveCount(14)
  await page.locator('.label-chip', { hasText: 'CW' }).click()
  await expect(items).toHaveCount(19)

  // Clicking an annotation selects it and zooms to it.
  const lora = items.filter({ hasText: 'LoRa' }).first()
  await lora.click()
  await expect(lora).toHaveClass(/selected/)
  await expect(page).toHaveURL(/v=/)

  // Hovering the selected annotation's centre shows its label in the readout.
  const box = (await page.locator('.spectrogram canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.readout-ann')).toHaveText('LoRa')
  expect(errors).toEqual([])
})

test('spectrum and time plots follow the visible window', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?q=ism_433')
  await page.locator('.tr').first().click()
  await expect(page.locator('.statusbar')).toContainText('strided overview')

  // Both panels are on by default and cover the whole recording.
  const spectrum = page.getByTestId('spectrum-plot')
  const time = page.getByTestId('time-plot')
  await expect(spectrum).toContainText('× 1024 FFT')
  await expect(time).toContainText('2,097,152 samples')
  await expect(time).toContainText('envelope')
  expect(await distinctColours(page, '[data-testid="spectrum-plot"] canvas')).toBeGreaterThan(3)

  // Annotations are drawn on the time plot; clicking one there selects it.
  // The first LoRa burst spans 300–335 ms of the 2.097 s recording.
  const over = time.locator('.u-over')
  const ob = (await over.boundingBox())!
  await over.click({ position: { x: ob.width * (0.317 / 2.097), y: ob.height / 2 } })
  await expect(page.locator('.ann-item.selected')).toContainText('LoRa')

  // Zooming to an annotation narrows the window: the time plot switches to raw samples.
  const timeReq = page.waitForRequest((r) => r.url().includes('/time?') && !r.url().includes('start=0&'))
  await page.locator('.ann-item', { hasText: 'LoRa' }).first().click()
  await timeReq
  await expect(time).not.toContainText('2,097,152 samples')
  await expect(time).not.toContainText('envelope')

  // T toggles the time panel (and the choice is remembered).
  await page.locator('.spectrogram').focus()
  await page.keyboard.press('t')
  await expect(time).toHaveCount(0)
  await page.reload()
  await expect(spectrum).toBeVisible()
  await expect(time).toHaveCount(0)
  expect(errors).toEqual([])
})

test('table rows preview their waterfall on hover; gallery shows thumbnails', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?q=chirps')
  await page.locator('.tr', { hasText: 'chirps' }).first().hover()
  const pop = page.locator('.preview-pop')
  await expect(pop.locator('.thumb-ready')).toBeVisible()
  expect(await distinctColours(page, '.preview-pop canvas')).toBeGreaterThan(20)
  await page.mouse.move(5, 5)
  await expect(pop).toHaveCount(0)

  // Gallery: one card per match, each with a drawn thumbnail.
  await page.getByRole('radio', { name: /Gallery/ }).click()
  await expect(page).toHaveURL(/view=gallery/)
  const cards = page.locator('.gcard')
  await expect(cards).toHaveCount(await page.locator('.source').count())
  await expect(cards.locator('.thumb-ready')).toHaveCount(await cards.count())

  // The choice is remembered without the URL parameter; broken files get a placeholder.
  await page.goto('/?status=broken')
  await expect(page.locator('.gcard .thumb-empty').first()).toContainText('missing .sigmf-meta')
  await page.goto('/?q=chirps')
  await page.locator('.gcard').first().click()
  await expect(page).toHaveURL(/\/r\/\d+/)
  expect(errors).toEqual([])
})

test('folders view browses sources and directories', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/?view=folders')
  await expect(page.locator('.source')).not.toHaveCount(0)
  const sources = await page.locator('.source').count()
  // Top level: one card per source, and the tree lists every source.
  await expect(page.locator('.subfolder')).toHaveCount(sources)
  await expect(page.locator('.crumb').first()).toContainText('All sources')

  // Open a source, then its demo folder: the table lists only what's directly in it.
  await page.locator('.subfolder').first().click()
  await page.locator('.subfolder', { hasText: 'demo' }).click()
  await expect(page).toHaveURL(/dir=[^&]+%2Fdemo/)
  await expect(page.locator('.tr')).toHaveCount(4)
  await expect(page.locator('.tree-row.selected')).toContainText('demo')
  await expect(page.locator('.crumb')).toHaveCount(3)

  // Search narrows the tree to folders with matches; Back returns to the parent.
  await page.locator('.search').fill('chirp')
  await expect(page.locator('.tr')).toHaveCount(1)
  await page.goBack()
  await expect(page.locator('.crumb')).toHaveCount(2)
  expect(errors).toEqual([])
})
