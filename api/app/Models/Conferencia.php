<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/**
 * "✓ Conferido" de uma nota ou de um repasse (18/11/2026). Ver a migração create_conferencias_table.
 *
 * Conferido = conferido_em preenchido e desmarcado_em vazio. Os carimbos ficam FORA do fillable: quem decide quem
 * conferiu e quando é o servidor, nunca o corpo da requisição.
 */
class Conferencia extends Model
{
    use HasUuids;

    protected $table = 'conferencias';

    protected $fillable = ['tipo', 'registro_id', 'dono_id'];

    protected function casts(): array
    {
        return ['conferido_em' => 'datetime', 'desmarcado_em' => 'datetime'];
    }

    private static ?bool $existe = null;

    /* A tabela existe? Protege o período entre publicar a API nova e a migração rodar: a ficha segue sem a marca. */
    public static function tabelaExiste(): bool
    {
        if (self::$existe === null) {
            try {
                self::$existe = Schema::hasTable('conferencias');
            } catch (\Throwable) {
                self::$existe = false;
            }
        }

        return self::$existe;
    }

    /** Só para teste: esquece o que foi memorizado. */
    public static function esquecerTabela(): void
    {
        self::$existe = null;
    }

    public function conferida(): bool
    {
        return $this->conferido_em !== null && $this->desmarcado_em === null;
    }

    /** O que o app usa: a marca, quem e quando (nomes já resolvidos). */
    public function paraApp(array $nomes = []): array
    {
        return [
            'tipo' => $this->tipo,
            'registro_id' => $this->registro_id,
            'dono_id' => $this->dono_id,
            'conferido' => $this->conferida(),
            'conferido_por' => $this->conferido_por,
            'conferido_por_nome' => $nomes[$this->conferido_por] ?? null,
            'conferido_em' => $this->conferido_em?->toIso8601ZuluString(),
            'desmarcado_por' => $this->desmarcado_por,
            'desmarcado_por_nome' => $nomes[$this->desmarcado_por] ?? null,
            'desmarcado_em' => $this->desmarcado_em?->toIso8601ZuluString(),
        ];
    }
}
