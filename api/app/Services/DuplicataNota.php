<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Trava anti-duplicata de EQUIPE (21/10/2026), num lugar só: a conferência do formulário (POST /notas/duplicada) e o
 * aviso automático à gestão (08/11/2026) usam as MESMAS regras.
 *   chave  → mesma chave de 44 dígitos
 *   nfse   → mesma consulta pública da NFS-e (chave de 50 dígitos)
 *   numero → mesmo fornecedor + mesmo número (série igual quando as duas têm)
 *   igual  → mesmo fornecedor + mesmo dia + mesmo valor + mesmo grupo (RDA/RDM)
 * Pedágio: o número do recibo (SEQ) e a data separam um do outro — número diferente nunca é duplicata, e número igual
 * só é quando o dia também é; hora do recibo diferente também separa (09/11/2026).
 * "Fornecedor" é o CNPJ quando os dois têm; senão a razão social. Roda sobre TODAS as notas vivas; lixeira não conta.
 *
 * Aviso (08/11/2026, pedido do Cleiton): o app só PERGUNTA ao colaborador ("Lançar assim mesmo?") e a nota entra.
 * Agora, quando uma nota duplicada é gravada, gestor e admin recebem push. Regra herdada dos outros avisos: nada aqui
 * atrapalha o envio da nota — erro vira log, nada é recusado nem apagado.
 */
class DuplicataNota
{
    /** Do mais forte para o mais fraco: quando várias notas casam, vale o melhor motivo. */
    private const FORCA_MOTIVO = ['chave' => 4, 'nfse' => 3, 'numero' => 2, 'igual' => 1];

    public const MOTIVO_TEXTO = [
        'chave' => 'mesma chave de acesso',
        'nfse' => 'mesma chave da NFS-e',
        'numero' => 'mesmo número de nota e fornecedor',
        'igual' => 'mesmo fornecedor, dia e valor',
    ];

    public function __construct(private PushService $push) {}

    /**
     * @param  array{chave?: ?string, qr_url?: ?string, tipo?: ?string, cnpj?: ?string, razao_social?: ?string, valor?: mixed, data?: ?string, numero?: ?string, serie?: ?string}  $d
     * @return array{0: Nota, 1: string}|null [nota que já existe, motivo]
     */
    public function achar(array $d, ?string $ignoreId = null): ?array
    {
        $chave = preg_replace('/\D/', '', (string) ($d['chave'] ?? ''));
        $chave = strlen($chave) === 44 ? $chave : '';
        $qrUrl = trim((string) ($d['qr_url'] ?? ''));
        $cand = [
            'tipo' => $d['tipo'] ?? null,
            'cnpj' => self::cnpjValido($d['cnpj'] ?? null),
            'razao' => self::razaoNormalizada($d['razao_social'] ?? null),
            'numero' => self::numeroDe($d['numero'] ?? null, $d['chave'] ?? null),
            'serie' => trim((string) ($d['serie'] ?? '')),
            'centavos' => isset($d['valor']) && is_numeric($d['valor']) ? (int) round(((float) $d['valor']) * 100) : 0,
            'data' => $d['data'] ?? null,
            'subtipo' => $d['subtipo'] ?? null,
            'hora' => self::horaMinuto($d['hora'] ?? null),
            'placa' => self::placaNormalizada($d['placa'] ?? null),
            /* dono da nota candidata; vazio = não informado ou Faturamento sem colaborador (aí não separa nada) */
            'dono' => trim((string) ($d['user_id'] ?? '')),
        ];

        /* Candidatas: tudo que casa por chave, link da NFS-e, número ou dia+valor. O resto (fornecedor, série, grupo)
           é conferido em PHP, com a mesma lógica do app, em cima de um conjunto pequeno. */
        $q = Nota::query()->where('deleted', false)
            ->when($ignoreId, fn ($q, $ig) => $q->where('id', '<>', $ig))
            ->where(function ($q) use ($chave, $qrUrl, $cand) {
                $q->whereRaw('0 = 1');
                if ($chave !== '') {
                    $q->orWhere('chave_nfce', $chave);
                }
                if ($qrUrl !== '') {
                    $q->orWhere('qr_url', $qrUrl);
                }
                if ($cand['numero'] !== '') {
                    $q->orWhereRaw("ltrim(numero, '0') = ?", [$cand['numero']]);
                }
                if ($cand['centavos'] > 0 && $cand['data']) {
                    $q->orWhere(fn ($q) => $q->where('data', $cand['data'])->whereRaw('abs(valor - ?) < 0.005', [$cand['centavos'] / 100]));
                }
            });

        $achada = null;
        $motivo = null;
        foreach ($q->orderBy('created_at')->limit(200)->get() as $n) {
            $m = $this->motivo($n, $chave, $qrUrl, $cand);
            if ($m !== null && ($motivo === null || self::FORCA_MOTIVO[$m] > self::FORCA_MOTIVO[$motivo])) {
                [$achada, $motivo] = [$n, $m];
            }
        }

        return $achada ? [$achada, $motivo] : null;
    }

    /**
     * Nota acabou de entrar (nova, ou restaurada da lixeira) — se ela repete outra nota viva, avisa gestor e admin
     * no celular. Quem gravou não recebe o próprio aviso. Nunca lança exceção.
     */
    public function avisarSeDuplicada(Nota $nota, ?Colaborador $autor = null): void
    {
        try {
            if ($nota->deleted) {
                return;
            }
            $achou = $this->achar([
                'chave' => $nota->chave_nfce, 'qr_url' => $nota->qr_url, 'tipo' => $nota->tipo,
                'cnpj' => $nota->cnpj, 'razao_social' => $nota->razao_social, 'valor' => $nota->valor,
                'data' => $nota->data?->format('Y-m-d'), 'numero' => $nota->numero, 'serie' => $nota->serie,
                'subtipo' => $nota->subtipo, 'hora' => $nota->hora, 'placa' => $nota->placa,
                'user_id' => $nota->user_id,
            ], $nota->id);
            if (! $achou) {
                return;
            }
            [$original, $motivo] = $achou;

            $dono = $nota->user_id ? Colaborador::find($nota->user_id) : null;
            $quem = $dono?->nome ?: ($autor?->nome ?: 'Alguém');
            $donoOriginal = $original->user_id === null ? 'Faturamento'
                : ($original->user_id === $nota->user_id ? 'a mesma pessoa' : (Colaborador::find($original->user_id)?->nome ?: 'outro colaborador'));
            $resumo = implode(' · ', array_filter([
                $nota->razao_social ?: null,
                $nota->tipo,
                'R$ '.number_format((float) $nota->valor, 2, ',', '.'),
                $nota->data?->format('d/m/Y'),
            ]));

            $gestores = Colaborador::whereIn('role', ['gestor', 'admin'])->where('ativo', true)
                ->when($autor, fn ($q) => $q->where('id', '<>', $autor->id))->get();
            /* A homologação é CÓPIA da produção, com inscrições de push de gente de verdade: lá só as contas de teste. */
            if (app()->environment('staging')) {
                $gestores = $gestores->filter(fn ($c) => str_ends_with(strtolower((string) $c->email), '@homolog.local'))->values();
            }

            Log::info('nota duplicada gravada', ['nota' => $nota->id, 'original' => $original->id, 'motivo' => $motivo]);
            $this->push->enviar(
                $gestores,
                'Nota duplicada lançada',
                "{$quem} lançou uma nota que já existe ({$this->textoMotivo($motivo)}; já lançada por {$donoOriginal}): {$resumo}",
                './?abrir=nota&id='.$nota->id,
                'nota-duplicada-'.$nota->id,
            );
        } catch (Throwable $e) {
            Log::warning('aviso de nota duplicada falhou', ['nota' => $nota->id, 'erro' => $e->getMessage()]);
        }
    }

    private function textoMotivo(string $motivo): string
    {
        return self::MOTIVO_TEXTO[$motivo] ?? $motivo;
    }

    private function motivo(Nota $n, string $chave, string $qrUrl, array $cand): ?string
    {
        if ($chave !== '' && preg_replace('/\D/', '', (string) $n->chave_nfce) === $chave) {
            return 'chave';
        }
        if ($qrUrl !== '' && trim((string) $n->qr_url) === $qrUrl) {
            return 'nfse';
        }
        if (! $this->mesmoFornecedor($n, $cand)) {
            return null;
        }
        /* Placa diferente nos dois lados = veículos diferentes, passagens diferentes (09/11/2026, EPR Triângulo R$ 14,50). */
        $placaDaNota = self::placaNormalizada($n->placa);
        if ($placaDaNota !== '' && $cand['placa'] !== '' && $placaDaNota !== $cand['placa']) {
            return null;
        }
        $num = self::numeroDe($n->numero, $n->chave_nfce);
        $serieDaNota = trim((string) $n->serie);
        /* Recibo com placa também é pedágio (09/11/2026, caso do Pedro): os recibos lançados antes da categoria Pedágio
           (05/11) ficaram em "Outros", mas o OCR já gravava a placa desde 27/10. */
        $pedagio = $n->subtipo === 'Pedágio' || $cand['subtipo'] === 'Pedágio'
            || trim((string) $n->placa) !== '' || $cand['placa'] !== '';
        $dataDaNota = $n->data?->format('Y-m-d');
        if ($num !== '' && $num === $cand['numero'] && ($cand['serie'] === '' || $serieDaNota === '' || $cand['serie'] === $serieDaNota)
            && ! ($pedagio && $cand['data'] && $dataDaNota && $cand['data'] !== $dataDaNota)) {
            return 'numero';
        }
        /* Pedágio (09/11/2026, pedido do Cleiton): a mesma praça cobra a mesma tarifa várias vezes no mesmo dia, então
           fornecedor + dia + valor não diz nada. Quem separa um recibo do outro é o número (SEQ) e a data: número igual em
           dia diferente não é a mesma passagem, e número diferente no mesmo dia também não. Sem número em um dos lados,
           segue a regra de sempre (pergunta). */
        /* 09/11/2026 (Cleiton, Casa das Balanças nº 31703 e 31704, R$ 70 no mesmo dia): número diferente nos dois lados
           separa em QUALQUER categoria, não só no pedágio. Decisão consciente: uma duplicata real com o número lido errado
           passa sem aviso. Sem número de um lado, segue a regra de sempre. */
        if ($num !== '' && $cand['numero'] !== '' && $num !== $cand['numero']) {
            return null;
        }
        /* Horário impresso no recibo (09/11/2026): duas passagens na mesma praça, no mesmo dia e com a mesma tarifa só se
           distinguem pela hora quando o número não foi lido. Hora diferente = passagem diferente. A hora só é gravada em
           recibo (documento "Outro"), então vale em qualquer categoria: dois recibos com hora impressa diferente são dois. */
        $horaDaNota = self::horaMinuto($n->hora);
        if ($horaDaNota !== '' && $cand['hora'] !== '' && $horaDaNota !== $cand['hora']) {
            return null;
        }
        /* Colaboradores diferentes (09/11/2026, pedido do Cleiton, EPR Triângulo R$ 14,50 no mesmo dia): duas pessoas passam
           na mesma praça, almoçam no mesmo lugar e pagam o mesmo valor no mesmo dia — fornecedor + dia + valor sozinho não
           diz que é a mesma nota. Só o motivo 'igual' cai; chave, NFS-e e número continuam valendo entre pessoas, e a
           nota de Faturamento sem colaborador (dono nulo) continua sendo conferida contra todos. */
        if ($cand['dono'] !== '' && $n->user_id !== null && $n->user_id !== $cand['dono']) {
            return null;
        }
        if ($cand['centavos'] > 0 && (int) round(((float) $n->valor) * 100) === $cand['centavos']
            && $cand['data'] && $n->data?->format('Y-m-d') === $cand['data']
            && $cand['tipo'] !== null && $n->tipo === $cand['tipo']
            && ! self::chavesDiferentes($n, $chave, $qrUrl)) {
            return 'igual';
        }

        return null;
    }

    /* Duas chaves diferentes são dois documentos, mesmo com fornecedor, dia e valor iguais: NFS-e 214 e 215 de
       duas sessões de R$ 80 emitidas juntas acusavam duplicata (06/11/2026). Só vale quando os DOIS lados têm chave do
       mesmo tipo. O motivo 'numero' não passa por aqui: chave lida do texto pode vir com um dígito errado. */
    private static function chavesDiferentes(Nota $n, string $chave, string $qrUrl): bool
    {
        $daNota = preg_replace('/\D/', '', (string) $n->chave_nfce);
        if ($chave !== '' && strlen($daNota) === 44 && $daNota !== $chave) {
            return true;
        }
        $nfseNota = self::chaveNfse($n->qr_url);
        $nfseCand = self::chaveNfse($qrUrl);

        return $nfseNota !== '' && $nfseCand !== '' && $nfseNota !== $nfseCand;
    }

    /** Chave de 50 dígitos da NFS-e nacional dentro do link da consulta; vazio se não houver. */
    private static function chaveNfse(?string $url): string
    {
        return preg_match('/(?<!\d)\d{50}(?!\d)/', (string) $url, $m) ? $m[0] : '';
    }

    /* CNPJ igual quando os dois têm; senão razão social igual (um recibo lido
       por OCR pode ter só o nome, e a nota antiga só o CNPJ). */
    private function mesmoFornecedor(Nota $n, array $cand): bool
    {
        $cnpjDaNota = self::cnpjValido($n->cnpj);
        if ($cnpjDaNota !== '' && $cand['cnpj'] !== '') {
            return $cnpjDaNota === $cand['cnpj'];
        }

        return $cand['razao'] !== '' && $cand['razao'] === self::razaoNormalizada($n->razao_social);
    }

    /** CNPJ só com dígitos; vazio e "00000000000000" não são CNPJ. */
    private static function cnpjValido(?string $v): string
    {
        $c = preg_replace('/\D/', '', (string) $v);

        return (strlen($c) === 14 && ! preg_match('/^0+$/', $c)) ? $c : '';
    }

    private static function razaoNormalizada(?string $v): string
    {
        return preg_replace('/\s+/', ' ', mb_strtoupper(trim((string) $v)));
    }

    /** "09:44:18" → "09:44": segundos lidos errado pelo OCR não separam passagens. Vazio quando não há hora. */
    private static function horaMinuto(?string $v): string
    {
        return preg_match('/^(\d{2}:\d{2})/', trim((string) $v), $m) ? $m[1] : '';
    }

    /** "txi-1f14" → "TXI1F14"; vazio quando não há placa. */
    private static function placaNormalizada(?string $v): string
    {
        return preg_replace('/[^A-Z0-9]/', '', mb_strtoupper(trim((string) $v)));
    }

    private static function numeroNormalizado(?string $v): string
    {
        return ltrim(trim((string) $v), '0');
    }

    /**
     * Número da nota; sem ele, o número de dentro da chave de NF-e/NFC-e (modelo 55/65, posições 26 a 34). Vale também com
     * a chave cortada na foto, desde que tenha chegado até o número (34 dígitos). Mesma conta de _numeroDaNota no app.
     */
    public static function numeroDe(?string $numero, ?string $chave): string
    {
        $num = self::numeroNormalizado($numero);
        if ($num !== '') {
            return $num;
        }
        $k = preg_replace('/\D/', '', (string) $chave);
        if (strlen($k) < 34 || strlen($k) > 44 || ! in_array(substr($k, 20, 2), ['55', '65'], true)) {
            return '';
        }

        return self::numeroNormalizado(substr($k, 25, 9));
    }
}
