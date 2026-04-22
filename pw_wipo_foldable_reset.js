async (page) => {
  const clear = page.getByText('clear current marks', { exact: false });
  if (await clear.count()) {
    await clear.first().click();
    await page.waitForTimeout(1200);
  }
  await page.locator('#PROD_input').fill('foldable crate');
  await page.click('#design_search .searchButton');
  await page.waitForTimeout(3500);
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="row"]')].filter(r => /DM\/\d+/.test(r.textContent||''));
    const data = rows.map(r => {
      const text = (r.textContent||'').replace(/\s+/g,' ').trim();
      const dm = (text.match(/DM\/\d+/)||[])[0]||null;
      const reg = (text.match(/HAGUE\.D\d+/)||[])[0]||null;
      const date = (text.match(/20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2}/)||[])[0]||null;
      const getDataMatch = text.match(/\.\.\/jsp\/getData\.jsp\?[^\s]+/);
      const img = r.querySelector('img')?.getAttribute('src') || null;
      return {
        dm, reg, date,
        text,
        getDataUrl:getDataMatch ? ('https://designdb.wipo.int/designdb/hague/' + getDataMatch[0].replace('../','')) : null,
        imageUrl: img ? (img.startsWith('//') ? ('https:' + img) : img) : null
      };
    });
    const summary = [...document.querySelectorAll('div,span,p')].map(n => (n.textContent||'').trim()).find(t => /\d+\s*-\s*\d+\s*\/\s*\d[\d,]*/.test(t)) || null;
    return {rows:data.length, summary, data:data.slice(0,5)};
  });
  return result;
}
