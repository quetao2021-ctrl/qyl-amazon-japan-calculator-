async (page) => {
  await page.locator('#basicSearchBigInput').fill('folding cart');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForTimeout(2500);
  const res = await page.evaluate(() => {
    const d=[...document.querySelectorAll('a')].find(a=>/Designs \(/.test(a.textContent||''));
    const t=[...document.querySelectorAll('a')].find(a=>/Trade marks \(/.test(a.textContent||''));
    const n=(el)=>{ if(!el) return null; const m=(el.textContent||'').match(/\((\d+)\)/); return m?Number(m[1]):null; };
    return {url: location.href, designs:n(d), trademarks:n(t)};
  });
  return res;
}
