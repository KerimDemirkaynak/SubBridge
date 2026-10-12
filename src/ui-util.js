// Small DOM helpers for the popup and the settings page. They build <option> elements with the DOM API
// (no innerHTML), which keeps the store validators quiet and avoids any injection risk.
function fillSelect(select, entries, value) {
    select.textContent = "";
    for (const [v, label] of entries) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        select.appendChild(o);
    }
    if (value !== undefined) select.value = value;
}
function fillDatalist(datalist, values) {
    datalist.textContent = "";
    for (const v of values) {
        const o = document.createElement("option");
        o.value = v;
        datalist.appendChild(o);
    }
}
// Engine dropdown entries; "custom" gets a translated name, brand names stay as they are.
function providerEntries(uiLang) {
    return TL_PROVIDERS.map(p => [p.id, p.id === "custom" ? i18nText("p_custom", uiLang) : p.name]);
}
