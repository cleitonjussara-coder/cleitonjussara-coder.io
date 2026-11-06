<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\NotaHistorico;
use Illuminate\Support\Facades\Log;

/**
 * Histórico por nota (06/11/2026, pedido do dono): grava quem mudou o quê e monta a leitura com rótulos legíveis.
 *
 * Regra de ouro: nada aqui derruba um lançamento. Toda gravação captura o erro e deixa um Log::warning; a nota já foi
 * salva e o colaborador em campo não pode ficar com o item preso na fila por causa de um registro de auditoria.
 */
class HistoricoNota
{
    /** Campos acompanhados. Fica de fora o que é técnico (updated_at, mes/ano que seguem a data, chave, QR, foto_em_branco). */
    public const CAMPOS = [
        'valor', 'data', 'tipo', 'subtipo', 'pagamento', 'cnpj', 'razao_social', 'numero', 'serie',
        'observacao', 'documento', 'placa', 'deleted', 'user_id',
    ];

    public const LIMITE = 200;

    private const ROTULO_CAMPO = [
        'valor' => 'Valor', 'data' => 'Data', 'tipo' => 'Grupo', 'subtipo' => 'Categoria', 'pagamento' => 'Pagamento',
        'cnpj' => 'CNPJ', 'razao_social' => 'Razão social', 'numero' => 'Número', 'serie' => 'Série',
        'observacao' => 'Observação', 'documento' => 'Documento', 'placa' => 'Placa', 'deleted' => 'Situação',
        'user_id' => 'Colaborador', 'anexo' => 'Anexo', 'fechamento' => 'Fechamento',
    ];

    private const ROTULO_ACAO = [
        'criacao' => 'Nota lançada', 'edicao' => 'Nota editada', 'tipo' => 'Grupo corrigido',
        'lixeira' => 'Enviada para a lixeira', 'restaurada' => 'Restaurada da lixeira', 'anexo' => 'Anexo alterado',
        'dono' => 'Colaborador trocado', 'exclusao' => 'Apagada em definitivo',
        'fora_fechamento' => 'Entrou com o mês fechado', 'conferida' => 'Conferida pela gestão',
    ];

    private const ROTULO_PAPEL = ['colaborador' => 'Colaborador', 'gestor' => 'Gestor', 'admin' => 'Admin', 'contabilidade' => 'Contador'];

    private const ROTULO_PAGAMENTO = ['cv' => 'Cartão', 'carteira' => 'Carteira', 'empresa' => 'Faturamento'];

    private const ROTULO_DOCUMENTO = ['nfce' => 'NFC-e', 'nfe' => 'NF-e', 'danfe' => 'DANFE', 'nfse' => 'NFS-e', 'outro' => 'Outro comprovante'];

    /**
     * Foto da nota nos campos acompanhados, já normalizada: é isso que faz o reenvio idêntico do aparelho não contar como
     * mudança ("50" e 50.00, "" e null, CNPJ com máscara, 14 zeros que o servidor limpa). Null se não deu para ler.
     */
    public function retrato(Nota $n): ?array
    {
        try {
            $texto = fn (mixed $v): ?string => ($s = trim((string) $v)) === '' ? null : $s;
            $cnpj = preg_replace('/\D/', '', (string) $n->cnpj);

            return [
                'valor' => $n->valor === null ? null : round((float) $n->valor, 2),
                'data' => $n->data?->format('Y-m-d'),
                'tipo' => $texto($n->tipo),
                'subtipo' => $texto($n->subtipo),
                'pagamento' => $texto($n->pagamento),
                'cnpj' => preg_match('/^0*$/', $cnpj) ? null : $cnpj,
                'razao_social' => $texto($n->razao_social),
                'numero' => $texto($n->numero),
                'serie' => $texto($n->serie),
                'observacao' => $texto($n->observacao),
                'documento' => $texto($n->documento),
                'placa' => $texto($n->placa),
                'deleted' => (bool) $n->deleted,
                'user_id' => $texto($n->user_id),
            ];
        } catch (\Throwable $e) {
            Log::warning('histórico da nota: não deu para ler a nota', ['nota' => $n->id, 'erro' => $e->getMessage()]);

            return null;
        }
    }

    /** Nota nova: guarda o que ela trouxe. Campo vazio não vira linha. */
    public function registrarCriacao(Nota $n, Colaborador $por): void
    {
        $retrato = $this->retrato($n);
        if ($retrato === null) {
            return;
        }
        $campos = [];
        foreach (array_filter($retrato, fn ($v) => $v !== null && $v !== false) as $campo => $valor) {
            $campos[$campo] = ['antes' => null, 'depois' => $valor];
        }
        $this->gravar($n->id, 'criacao', $campos, $por);
    }

    /**
     * Compara a nota salva com o retrato de antes e grava só o que mudou. Sem diferença não grava nada.
     * A ação sai do que mudou: o aparelho manda lixeira e restauração pelo mesmo PUT da edição.
     */
    public function registrarMudanca(?array $antes, Nota $n, Colaborador $por, bool $anexoTrocado = false): void
    {
        $depois = $this->retrato($n);
        if ($antes === null || $depois === null) {
            return;
        }
        $campos = [];
        foreach (self::CAMPOS as $campo) {
            if ($antes[$campo] !== $depois[$campo]) {
                $campos[$campo] = ['antes' => $antes[$campo], 'depois' => $depois[$campo]];
            }
        }
        $acao = $this->acaoDe($campos);
        if ($anexoTrocado) {
            $campos['anexo'] = ['antes' => null, 'depois' => 'anexo trocado'];
            $acao ??= 'anexo';
        }
        if ($acao !== null) {
            $this->gravar($n->id, $acao, $campos, $por);
        }
    }

    /** Anexo novo. O caminho do arquivo nunca entra no histórico: só o fato. */
    public function registrarAnexo(string $notaId, Colaborador $por, string $texto = 'anexo trocado'): void
    {
        $this->gravar($notaId, 'anexo', ['anexo' => ['antes' => null, 'depois' => $texto]], $por);
    }

    /**
     * 06/11/2026: a nota entrou com o mês fechado, ou a gestão a conferiu. Fechar e reabrir um mês não passam por aqui: uma linha
     * em cada nota seriam milhares de registros iguais, e o histórico do mês já diz quem, quando e por quê.
     */
    public function registrarFechamento(string $notaId, string $acao, Colaborador $por, string $texto): void
    {
        $this->gravar($notaId, $acao, ['fechamento' => ['antes' => null, 'depois' => $texto]], $por);
    }

    /** Exclusão definitiva: guarda como a nota estava, porque depois disso a linha dela não existe mais. */
    public function registrarExclusao(?array $antes, string $notaId, Colaborador $por): void
    {
        $campos = [];
        foreach (array_filter($antes ?? [], fn ($v) => $v !== null && $v !== false) as $campo => $valor) {
            if ($campo !== 'deleted') {
                $campos[$campo] = ['antes' => $valor, 'depois' => null];
            }
        }
        $this->gravar($notaId, 'exclusao', $campos, $por);
    }

    /** Do mais novo para o mais velho, com os rótulos prontos para a tela. */
    public function listar(string $notaId): array
    {
        $linhas = NotaHistorico::where('nota_id', $notaId)
            ->orderByDesc('alterado_em')->orderByDesc('id')->limit(self::LIMITE)->get();

        /* nomes de uma vez: quem alterou e os donos citados nas trocas */
        $ids = $linhas->pluck('alterado_por');
        foreach ($linhas as $l) {
            $ids = $ids->merge(array_values(array_intersect_key($l->campos['user_id'] ?? [], ['antes' => 1, 'depois' => 1])));
        }
        $nomes = Colaborador::whereIn('id', $ids->filter()->unique()->values()->all())->get(['id', 'nome', 'email'])
            ->mapWithKeys(fn ($c) => [$c->id => $c->nome ?: $c->email])->all();

        return $linhas->map(fn (NotaHistorico $l) => [
            'id' => $l->id,
            'acao' => $l->acao,
            'acao_rotulo' => self::ROTULO_ACAO[$l->acao] ?? $l->acao,
            'alterado_em' => $l->alterado_em?->toISOString(),
            'por_nome' => $l->alterado_por === null ? 'Sistema' : ($nomes[$l->alterado_por] ?? 'Colaborador excluído'),
            'por_papel' => $l->alterado_papel,
            'papel_rotulo' => self::ROTULO_PAPEL[$l->alterado_papel] ?? '',
            'campos' => collect($l->campos ?? [])->map(fn ($v, $campo) => [
                'campo' => $campo,
                'rotulo' => self::ROTULO_CAMPO[$campo] ?? $campo,
                'antes' => $this->rotuloValor($campo, $v['antes'] ?? null, $nomes),
                'depois' => $this->rotuloValor($campo, $v['depois'] ?? null, $nomes),
            ])->values()->all(),
        ])->all();
    }

    /* Vários campos numa edição continuam sendo "edição"; lixeira e dono têm prioridade por mudarem a vida da nota. */
    private function acaoDe(array $campos): ?string
    {
        if ($campos === []) {
            return null;
        }
        if (isset($campos['deleted'])) {
            return $campos['deleted']['depois'] ? 'lixeira' : 'restaurada';
        }
        if (isset($campos['user_id'])) {
            return 'dono';
        }

        return array_diff(array_keys($campos), ['tipo', 'subtipo']) === [] ? 'tipo' : 'edicao';
    }

    private function gravar(string $notaId, string $acao, array $campos, Colaborador $por): void
    {
        try {
            if (! NotaHistorico::tabelaExiste()) {
                return;
            }
            NotaHistorico::create([
                'nota_id' => $notaId, 'acao' => $acao, 'campos' => $campos,
                'alterado_por' => $por->id, 'alterado_papel' => $por->role, 'alterado_em' => now(),
            ]);
        } catch (\Throwable $e) {
            Log::warning('histórico da nota não gravado', ['nota' => $notaId, 'acao' => $acao, 'por' => $por->email, 'erro' => $e->getMessage()]);
        }
    }

    private function rotuloValor(string $campo, mixed $v, array $nomes): ?string
    {
        if ($campo === 'user_id') {
            return $v === null ? 'Sem colaborador' : ($nomes[$v] ?? 'Colaborador excluído');
        }
        if ($campo === 'deleted') {
            return $v ? 'Na lixeira' : 'Ativa';
        }
        if ($v === null) {
            return null;
        }

        return match ($campo) {
            'valor' => 'R$ '.number_format((float) $v, 2, ',', '.'),
            'data' => preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', (string) $v, $m) ? "{$m[3]}/{$m[2]}/{$m[1]}" : (string) $v,
            'pagamento' => self::ROTULO_PAGAMENTO[$v] ?? (string) $v,
            'documento' => self::ROTULO_DOCUMENTO[$v] ?? (string) $v,
            'cnpj' => preg_match('/^\d{14}$/', (string) $v)
                ? preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', (string) $v) : (string) $v,
            default => (string) $v,
        };
    }
}
