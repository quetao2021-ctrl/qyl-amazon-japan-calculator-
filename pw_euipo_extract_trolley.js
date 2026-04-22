async (page) => {
  await page.goto('https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/trolley');
  await page.waitForTimeout(3500);
  await page.getByRole('link', { name: /Designs \(/ }).click();
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => {
    const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cards = [...document.querySelectorAll('h3')].filter(h => /\d{6,}-\d{4}/.test(h.textContent || ''));
    const getField = (root, key) => {
      const dts = [...root.querySelectorAll('dt')];
      const dt = dts.find(x => txt(x.textContent).toLowerCase() === key.toLowerCase());
      if (!dt) return null;
      const dd = dt.nextElementSibling;
      return dd ? txt(dd.textContent) : null;
    };
    const out = [];
    for (const h of cards.slice(0, 25)) {
      let root = h.parentElement;
      while (root && !root.querySelector('dt')) root = root.parentElement;
      if (!root) continue;
      const heading = txt(h.textContent).replace(/\+ info$/i, '').trim();
      const numMatch = heading.match(/(\d{6,}-\d{4})/);
      const designNumber = numMatch ? numMatch[1] : getField(root, 'Design number');
      const imageLink = root.querySelector('a[href*="/copla/image/"]');
      out.push({
        heading,
        designNumber,
        filingDate: getField(root, 'Filing date'),
        locarno: getField(root, 'Locarno class number'),
        product: getField(root, 'Indication of the product'),
        status: getField(root, 'Design status'),
        image: imageLink ? imageLink.href : null,
        detail: designNumber ? `https://euipo.europa.eu/eSearch/#details/designs/${designNumber}` : null
      });
    }
    return out;
  });
  return data;
}
