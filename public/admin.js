const notice = document.querySelector('#notice');
const login = document.querySelector('#login');
const product = document.querySelector('#product');
const logout = document.querySelector('#logout');

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const response = await fetch('/api/admin/' + path, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function setSignedIn(signedIn) {
  login.hidden = signedIn;
  product.hidden = !signedIn;
  logout.hidden = !signedIn;
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(file);
  });
}

function submit(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    notice.textContent = '';
    try { await action(); }
    catch (error) {
      if (form === product && error.status === 401) setSignedIn(false);
      notice.textContent = error.message || 'Something went wrong.';
    } finally { button.disabled = false; }
  });
}

submit(login, async () => {
  await request('login', { password: login.elements.password.value });
  login.reset();
  setSignedIn(true);
  product.elements.name.focus();
});

submit(product, async () => {
  const fields = new FormData(product);
  const file = fields.get('image');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a photo up to 5 MB.');
  const saved = await request('products', {
    name: fields.get('name'),
    category: fields.get('category'),
    price: Number(fields.get('price')),
    image: await readPhoto(file),
  });
  product.reset();
  notice.textContent = saved.name + ' is now visible in the storefront.';
});

logout.addEventListener('click', async () => {
  try {
    await request('logout', {});
    product.reset();
    setSignedIn(false);
    notice.textContent = 'Signed out.';
    login.elements.password.focus();
  } catch (error) { notice.textContent = error.message; }
});

request('session').then(result => {
  setSignedIn(result.signedIn);
  notice.textContent = '';
}).catch(() => { notice.textContent = 'Could not connect. Refresh the page to try again.'; });
