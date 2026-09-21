<?php

namespace App\Models;

use App\Notifications\RedefinirSenha;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

/**
 * Perfil + credenciais do usuário (antes: auth.users + public.colaboradores).
 *
 * O id é o UUID que veio do Supabase (ou gerado no cadastro). Não é
 * autoincremento: o app cria ids no aparelho, offline, e o servidor só
 * respeita.
 */
class Colaborador extends Authenticatable
{
    use HasApiTokens, Notifiable;

    /* contabilidade (reunião de 21/09/2026): só VÊ e BAIXA — Equipe, cartões,
       relatórios. Não lança nota/repasse, não edita, não exclui. */
    public const ROLES = ['colaborador', 'gestor', 'admin', 'contabilidade'];

    protected $table = 'colaboradores';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'nome', 'email', 'password', 'role', 'nucleo', 'google_id', 'foto_path', 'ativo', 'desativado_em', 'exclusao_pedida_por', 'exclusao_pedida_em'];

    protected $hidden = ['password', 'remember_token', 'google_id'];

    /* Mesmos padrões do banco, para o JSON do cadastro já sair completo
       (create() não relê a linha). */
    protected $attributes = ['role' => 'colaborador', 'nucleo' => 'Cristalina'];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'ativo' => 'boolean',
            'desativado_em' => 'datetime',
            'exclusao_pedida_em' => 'datetime',
        ];
    }

    public function notas(): HasMany
    {
        return $this->hasMany(Nota::class, 'user_id');
    }

    public function repasses(): HasMany
    {
        return $this->hasMany(Repasse::class, 'user_id');
    }

    /* LEITURA de tudo (todos os núcleos): gestor, admin e contabilidade.
       É a regra das policies notas_sel / rep_sel / colab_sel do Supabase. */
    public function veTudo(): bool
    {
        return in_array($this->role, ['gestor', 'admin', 'contabilidade'], true);
    }

    /* ESCRITA sobre os outros (desativar, excluir, corrigir ponto, veículos,
       feriados, gravar nota de outro): só gestor e admin. */
    public function gerencia(): bool
    {
        return in_array($this->role, ['gestor', 'admin'], true);
    }

    /* Contabilidade não lança nada, nem para si. */
    public function soLeitura(): bool
    {
        return $this->role === 'contabilidade';
    }

    public function sendPasswordResetNotification($token): void
    {
        $this->notify(new RedefinirSenha($token));
    }

    public function ehAdmin(): bool
    {
        return $this->role === 'admin';
    }
}
