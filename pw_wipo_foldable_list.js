async (page) => {
  await page.goto('https://designdb.wipo.int/designdb/hague/en/');
  await page.waitForTimeout(2500);
  await page.locator('#PROD_input').fill('foldable crate');
  await page.click('#design_search .searchButton');
  await page.waitForTimeout(3500);
  return await page.evaluate(() => {
    const parseProduct = (text) => {
      const m = text.match(/\d{2}-\d{2}(?:\s*\d\.)?\s*([^]+?)\s+(?:[A-Z]{2}(?:,[A-Z]{2})*)\s*$/);
      return m ? m[1].trim() : null;
    };
    const rows = [...document.querySelectorAll('[role="row"]')].filter(r => /DM\/\d+/.test(r.textContent||''));
    const data = rows.slice(0,10).map(r => {
      const text = (r.textContent||'').replace(/\s+/g,' ').trim();
      const dm = (text.match(/DM\/\d+/)||[])[0]||null;
      const reg = (text.match(/HAGUE\.D\d+/)||[])[0]||null;
      const date = (text.match(/20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2}/)||[])[0]||null;
      const gd = (text.match(/\.\.\/jsp\/getData\.jsp\?[^\s]+/)||[])[0] || null;
      const img = r.querySelector('img')?.getAttribute('src') || null;
      const prod = parseProduct(text);
      return {
        reg, dm, date, product: prod,
        detail: gd ? ('https://designdb.wipo.int/designdb/hague/' + gd.replace('../','')) : null,
        image: img ? (img.startsWith('//') ? ('https:' + img) : img) : null,
        raw: text
      };
    });
    return data;
  });
}
