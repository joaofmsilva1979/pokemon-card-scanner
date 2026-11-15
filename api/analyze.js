module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { recto, verso } = req.body;
  if (!recto || !verso) return res.status(400).json({ error: 'Images manquantes' });

  // 1. Identification + authenticité via Claude vision
  let cardInfo;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: recto } },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: verso } },
            {
              type: 'text',
              text: `Tu es un expert authentificateur de cartes Pokémon. Analyse le recto (1ère image) et le verso (2ème image).

Retourne UNIQUEMENT un objet JSON valide, sans markdown :

{
  "name_fr": "nom exact en français sur la carte",
  "name_en": "nom en anglais",
  "set_name": "nom de l'extension",
  "card_number": "format XXX/YYY",
  "rarity": "common|uncommon|rare|rare_holo|ultra_rare|secret_rare|promo",
  "rarity_fr": "Commune|Peu commune|Rare|Rare Holographique|Ultra Rare|Rare Secrète|Promo",
  "is_real": true,
  "authenticity_confidence": "high|medium|low",
  "authenticity_notes": "observations clés sur l'authenticité",
  "fake_indicators": [],
  "copyright_year": "2021",
  "artist": "nom de l'illustrateur",
  "search_name_en": "nom anglais simplifié sans accents pour API"
}

Symboles de rareté : ○ = Commune, ◇ = Peu commune, ★ = Rare, ★ brillante = Rare Holo, ★ pleine = Ultra Rare, ★ arc-en-ciel = Secrète.

Critères d'authenticité : verso bleu (~#4E6CC2) avec rosette Poké Ball centrée, police Futura Bold nette, bordure uniforme, HP cohérents, copyright format standard.`
            }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    cardInfo = JSON.parse(match ? match[0] : text);
  } catch (e) {
    return res.status(500).json({ error: 'Analyse échouée', detail: e.message });
  }

  // 2. Prix via pokemontcg.io (inclut les prix cardmarket)
  let price = null;
  try {
    const number = cardInfo.card_number?.split('/')?.[0]?.replace(/^0+/, '');
    const name = cardInfo.search_name_en || cardInfo.name_en || cardInfo.name_fr;
    const headers = process.env.POKEMONTCG_API_KEY
      ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY }
      : {};

    for (const q of [`name:"${name}" number:${number}`, `name:"${name}"`]) {
      const tcgRes = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=20`,
        { headers }
      );
      const tcgData = await tcgRes.json();
      const cards = tcgData.data || [];

      const best = cards.find(c =>
        c.number === number ||
        c.number === cardInfo.card_number?.split('/')?.[0]
      ) || cards[0];

      if (best?.cardmarket?.prices) {
        const p = best.cardmarket.prices;
        price = {
          avg_sell: p.averageSellPrice,
          trend: p.trendPrice,
          low: p.lowPrice,
          avg30: p.avg30,
          updated_at: best.cardmarket.updatedAt,
        };
        cardInfo.tcg_id = best.id;
        cardInfo.set_name = best.set?.name || cardInfo.set_name;
        break;
      }
    }
  } catch (_) {
    // prix reste null, non bloquant
  }

  res.json({ ...cardInfo, price });
};
