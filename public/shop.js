let shopWhatsApp = '';
let products = [];
const formatPrice = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const grid = document.querySelector('#products');
const filters = document.querySelectorAll('[data-category]');
const dialog = document.querySelector('dialog');

function enquire(product) {
  const message = product
    ? `Hi The Ivory Edit! I'm interested in the ${product.name} (${product.id}) listed at ${formatPrice.format(product.price)}. Is it available?`
    : 'Hi The Ivory Edit! I’d like to enquire about your collection.';
  if (/^[1-9]\d{6,14}$/.test(shopWhatsApp)) {
    window.open(`https://wa.me/${shopWhatsApp}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    return;
  }
  document.querySelector('#message').value = message;
  dialog.showModal();
}

function render(category) {
  const shown = category === 'All' ? products : products.filter(product => product.category === category);
  document.querySelector('#catalogue-status').textContent = shown.length ? '' : 'No products in this category yet.';
  grid.replaceChildren(...shown.map(product => {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = '<img width="480" height="480" loading="lazy" alt=""><div class="details"><p class="category"></p><h3></h3><div class="card-actions"><span></span><button type="button" class="outline">Enquire</button></div></div>';
    const image = card.querySelector('img');
    image.src = product.image;
    image.alt = product.name;
    card.querySelector('.category').textContent = product.category;
    card.querySelector('h3').textContent = product.name;
    card.querySelector('.card-actions span').textContent = formatPrice.format(product.price);
    card.querySelector('button').setAttribute('aria-label', 'Enquire about ' + product.name);
    card.querySelector('button').addEventListener('click', () => enquire(product));
    return card;
  }));
  document.querySelector('#results').textContent = `${shown.length} products shown`;
}

filters.forEach(filter => filter.addEventListener('click', () => {
  filters.forEach(button => button.setAttribute('aria-pressed', String(button === filter)));
  render(filter.dataset.category);
}));
document.querySelectorAll('[data-enquiry]').forEach(button => button.addEventListener('click', () => enquire()));
async function loadProducts() {
  const status = document.querySelector('#catalogue-status');
  try {
    const response = await fetch('/api/products');
    if (!response.ok) throw new Error('Catalogue unavailable');
    ({ products, shopWhatsApp } = await response.json());
    render(document.querySelector('[data-category][aria-pressed="true"]').dataset.category);
  } catch {
    status.textContent = 'Could not load the catalogue. Refresh the page to try again.';
  }
}
loadProducts();
