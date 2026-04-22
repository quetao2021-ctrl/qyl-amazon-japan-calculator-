async (page) => {
  await page.locator('#basicSearchSmallInput').fill('trolley');
  await page.locator('#basicSearchSmallButton').click();
  await page.waitForTimeout(3500);
  await page.getByRole('link', { name: /Designs \(/ }).click();
  await page.waitForTimeout(2500);
  const first = page.locator('h3').filter({ hasText: /\d{6,}-\d{4}/ }).first();
  const title = await first.textContent();
  await first.click();
  await page.waitForTimeout(3000);
  return {clicked:title, url: page.url(), titleDoc: await page.title()};
}
