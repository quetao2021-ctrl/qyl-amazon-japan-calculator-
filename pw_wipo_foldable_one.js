async (page) => {
  await page.locator('#PROD_input').fill('foldable crate');
  await page.click('#design_search .searchButton');
  await page.waitForTimeout(3500);
  const result = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[role="row"]')].find(r => /DM\/\d+/.test(r.textContent||''));
    if(!row) return null;
    const text = (row.textContent||'').replace(/\s+/g,' ').trim();
    const dm = (text.match(/DM\/\d+/)||[])[0]||null;
    const reg = (text.match(/HAGUE\.D\d+/)||[])[0]||null;
    const date = (text.match(/20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2}/)||[])[0]||null;
    const product = (/Foldable trolley/i.test(text) ? 'Foldable trolley' : null);
    const getDataMatch = text.match(/\.\.\/jsp\/getData\.jsp\?[^\s]+/);
    const img = row.querySelector('img')?.getAttribute('src') || null;
    return {
      dm,reg,date,product,
      raw:text,
      getDataRel:getDataMatch ? getDataMatch[0] : null,
      getDataUrl:getDataMatch ? ('https://designdb.wipo.int/designdb/hague/' + getDataMatch[0].replace('../','')) : null,
      imageUrl: img ? (img.startsWith('//') ? ('https:' + img) : img) : null
    };
  });
  return result;
}
