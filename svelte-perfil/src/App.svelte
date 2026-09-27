<script>
  /* Só o topo do Perfil: avatar/foto + nome. O resto da tela (Drive,
     armazenamento, backup, CPF, atualizar banco) continua vanilla JS,
     colado logo depois deste componente no mesmo #app-content — de
     propósito, ver README. */
  let { user, onEnviarFoto, onRemoverFoto, onSalvarPerfil } = $props();

  const iniciais = (user?.nome || '?')[0].toUpperCase();
</script>

<div class="perfil-card">
  <div class="perfil-avatar" id="perfil-avatar">{iniciais}</div>
  <input type="file" id="p-foto" accept="image/*" capture="user" style="display:none" onchange={onEnviarFoto}>
  <input type="file" id="p-foto-galeria" accept="image/*" style="display:none" onchange={onEnviarFoto}>
  <div class="botoes-foto">
    <button class="btn btn-sm btn-primary" onclick={() => document.getElementById('p-foto').click()}>📷 Tirar foto</button>
    <button class="btn btn-sm btn-outline" onclick={() => document.getElementById('p-foto-galeria').click()}>🖼️ Da galeria</button>
    {#if user?.foto_path}
      <button class="btn btn-sm btn-outline" onclick={onRemoverFoto}>Remover</button>
    {/if}
  </div>
  <p class="dica-recorte">Depois da foto, enquadre o rosto e toque em <b>Usar recorte</b>.</p>
  <div class="perfil-nome">{user?.nome || user?.email || ''}</div>
  <div class="perfil-email">{user?.email || ''}</div>
  <div class="perfil-meta">
    <span class="role-pill role-{user?.role || 'colaborador'}">{user?.role || 'colaborador'}</span>
  </div>
</div>

<div class="perfil-form">
  <label class="lbl">Nome</label>
  <input class="inp" id="p-nome" value={user?.nome || ''} autocomplete="name" autocapitalize="words">
  <button class="btn btn-primary" onclick={onSalvarPerfil}>Salvar perfil</button>
</div>

<style>
  .botoes-foto { display: flex; gap: 8px; justify-content: center; margin: -4px 0 10px; flex-wrap: wrap; }
  .dica-recorte { font-size: 15px; color: var(--text2); text-align: center; margin: -4px 0 8px; }
</style>
