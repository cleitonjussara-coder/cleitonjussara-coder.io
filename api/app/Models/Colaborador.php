<?php

namespace App\Models;

use App\Notifications\RedefinirSenha;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Support\Facades\Schema;
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

    /* regime (21/09/2026): rdm_rda = recebe dinheiro em conta; cv = cartão corporativo */
    public const REGIMES = ['rdm_rda', 'cv'];

    protected $fillable = ['id', 'nome', 'email', 'password', 'role', 'nucleo', 'regime', 'google_id', 'foto_path', 'ativo', 'desativado_em', 'exclusao_pedida_por', 'exclusao_pedida_em', 'confirmado_em', 'confirmado_por', 'criado_via'];

    protected $hidden = ['password', 'remember_token', 'google_id'];

    /* Mesmos padrões do banco, para o JSON do cadastro já sair completo
       (create() não relê a linha). */
    protected $attributes = ['role' => 'colaborador', 'nucleo' => 'Cristalina', 'regime' => 'rdm_rda'];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'ativo' => 'boolean',
            'desativado_em' => 'datetime',
            'exclusao_pedida_em' => 'datetime',
            'confirmado_em' => 'datetime',
        ];
    }

    /* A coluna existe no banco? (memorizado). Protege o período entre
       publicar a API nova e a migração rodar: sem isto, o INSERT do cadastro
       quebraria com "no such column". */
    public static function temConfirmacao(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasColumn('colaboradores', 'confirmado_em');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }

    public function confirmado(): bool
    {
        /* Se a coluna ainda não existe no banco (API nova publicada antes da
           migração rodar), o atributo nem aparece: ninguém pode ser tratado
           como pendente, senão a equipe inteira ficaria trancada fora do app. */
        if (! array_key_exists('confirmado_em', $this->getAttributes())) {
            return true;
        }

        return $this->confirmado_em !== null;
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

    /* MANUTENÇÃO do servidor (backup, espaço em disco, migrações, cópia no
       Drive). Era só do admin; desde 22/09/2026 o gestor faz o mesmo — o
       Perfil dos dois mostra as mesmas ferramentas (pedido do Cleiton: o
       backup não pode depender de uma pessoa só estar disponível).
       Contabilidade, que é papel de leitura, continua fora. */
    public function manutencao(): bool
    {
        return $this->gerencia();
    }

    public function ehCV(): bool
    {
        return $this->regime === 'cv';
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
