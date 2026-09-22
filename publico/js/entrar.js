// A tela de entrada.
//
// Este codigo morava dentro de um <script> no proprio index.html. Saiu de la
// para a CSP poder dizer `script-src 'self'`: com script embutido na pagina, a
// unica CSP possivel seria com 'unsafe-inline', que autoriza exatamente o que
// ela deveria barrar.

import { api, mostrarRecado } from '/js/comum.js';

const form = document.getElementById('formulario');
const botao = document.getElementById('botao');

// Se ja tem sessao aberta, pula direto pra dentro.
try {
  const eu = await api('/api/eu');
  irPraDentro(eu.usuario);
} catch { /* sem sessao, mostra o login mesmo */ }

function irPraDentro(usuario) {
  const confere = usuario.papel === 'admin' || usuario.papel === 'super';
  location.href = confere ? '/admin.html' : '/app.html';
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  botao.disabled = true;
  botao.textContent = 'Entrando...';
  try {
    const r = await api('/api/entrar', {
      metodo: 'POST',
      corpo: {
        login: document.getElementById('login').value,
        senha: document.getElementById('senha').value,
      },
    });
    irPraDentro(r.usuario);
  } catch (e) {
    mostrarRecado('recado', e.message, 'erro');
    botao.disabled = false;
    botao.textContent = 'Entrar';
    document.getElementById('senha').select();
  }
});
