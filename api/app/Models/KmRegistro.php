<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Leitura do odômetro de um veículo, feita por um colaborador. */
class KmRegistro extends Model
{
    protected $table = 'km_registros';

    protected $keyType = 'string';

    public $incrementing = false;

    private static ?bool $temAuditoria = null;

    protected $fillable = ['id', 'veiculo_id', 'user_id', 'data', 'odometro', 'observacao', 'foto_path', 'deleted', 'registrado_em', 'atualizado_por'];

    protected function casts(): array
    {
        return [
            'data' => 'date:Y-m-d',
            'odometro' => 'integer',
            'deleted' => 'boolean',
            'registrado_em' => 'datetime',
        ];
    }

    /* As colunas registrado_em/atualizado_por existem no banco? (memorizado).
       Protege o período entre publicar a API nova e a migração rodar: sem isto
       o INSERT do registro de km quebraria com "no such column". */
    public static function temAuditoria(): bool
    {
        if (self::$temAuditoria === null) {
            try {
                self::$temAuditoria = Schema::hasColumn('km_registros', 'registrado_em');
            } catch (\Throwable) {
                self::$temAuditoria = false;
            }
        }

        return self::$temAuditoria;
    }

    /**
     * Última leitura de cada veículo (de qualquer pessoa), opcionalmente só as
     * ANTES de uma data: [veiculo_id => linha crua do banco]. Dia mais recente;
     * no mesmo dia, o maior odômetro.
     */
    public static function ultimasPorVeiculo(?string $antesDe = null): array
    {
        $datas = DB::table('km_registros')->where('deleted', false)->groupBy('veiculo_id')->selectRaw('veiculo_id, max(data) as d');
        if ($antesDe !== null) {
            $datas->where('data', '<', $antesDe);
        } else {
            /* "última leitura" nunca é uma data que ainda não chegou (registro antigo com ano errado não vira a referência de todo mundo) */
            $datas->where('data', '<=', now('America/Sao_Paulo')->format('Y-m-d').' 23:59:59');
        }
        $cols = ['k.id', 'k.veiculo_id', 'k.user_id', 'k.data', 'k.odometro', 'k.created_at'];
        if (self::temAuditoria()) {
            $cols[] = 'k.registrado_em';
        }
        $linhas = DB::table('km_registros as k')
            ->joinSub($datas, 'm', fn ($j) => $j->on('m.veiculo_id', '=', 'k.veiculo_id')->on('m.d', '=', 'k.data'))
            ->where('k.deleted', false)
            ->get($cols);

        $saida = [];
        foreach ($linhas as $l) {
            $l = (array) $l;
            $v = $l['veiculo_id'];
            $hora = fn (array $x) => (string) ($x['registrado_em'] ?? $x['created_at']);
            if (! isset($saida[$v]) || [$l['odometro'], $hora($l), $l['id']] > [$saida[$v]['odometro'], $hora($saida[$v]), $saida[$v]['id']]) {
                $saida[$v] = $l;
            }
        }

        return $saida;
    }

    /** Só para teste: esquece a resposta memorizada (o banco do teste muda de schema). */
    public static function esquecerAuditoria(): void
    {
        self::$temAuditoria = null;
    }

    public function veiculo(): BelongsTo
    {
        return $this->belongsTo(Veiculo::class, 'veiculo_id');
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    /* Mesma regra das notas: dono vê os seus; gestor/admin veem tudo. */
    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->veTudo() ? $q : $q->where('user_id', $u->id);
    }
}
