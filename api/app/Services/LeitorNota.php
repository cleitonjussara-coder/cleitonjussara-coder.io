<?php

namespace App\Services;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Lê os campos de uma foto de nota fiscal (cupom NFC-e, DANFE, NFS-e, recibo)
 * com um modelo de visão (10/10/2026). No app é a PRIMEIRA leitura (com
 * internet); o Tesseract do aparelho fica de reserva.
 *
 * Uma IA pode errar ou "completar" dígitos — e aqui o erro vira despesa
 * lançada. Por isso NADA do que ela devolve é aceito sem conferir:
 *   CNPJ       → dígitos verificadores
 *   chave (44) → dígito verificador + UF, AAMM, modelo e CNPJ embutido plausíveis;
 *                se confere, o CNPJ dela manda (e a razão social lida de outra
 *                empresa é descartada) e a data tem que cair no mês dela
 *   chave NFS-e (50) → estrutura (UF, tipo de inscrição, mês e ano plausíveis)
 *   data       → AAAA-MM-DD real, de 2000 até amanhã (nunca no futuro)
 *   valor      → número > 0 e abaixo de R$ 1 milhão; formato ambíguo
 *                ("1.234", "12,345") vira null em vez de chute
 *   número/série → um único grupo de dígitos
 * O que não passa vira null e o app preenche pelo Tesseract ou à mão. O
 * resultado é sempre uma SUGESTÃO que a pessoa confere antes de salvar.
 */
class LeitorNota
{
    private const CAMPOS = ['cnpj', 'razao_social', 'valor', 'data', 'numero', 'serie', 'chave', 'chave_nfse'];

    private const UFS = ['11', '12', '13', '14', '15', '16', '17', '21', '22', '23', '24', '25', '26', '27', '28', '29',
        '31', '32', '33', '35', '41', '42', '43', '50', '51', '52', '53'];

    private const PROMPT = 'Esta é a foto de um documento fiscal brasileiro (cupom NFC-e, DANFE, nota de serviço NFS-e ou recibo). '
        .'Extraia SOMENTE os campos abaixo e responda apenas com JSON, sem texto fora do JSON: '
        .'{"cnpj": "...", "razao_social": "...", "valor": 0.00, "data": "AAAA-MM-DD", "numero": "...", "serie": "...", "chave": "...", "chave_nfse": "..."} '
        .'Regras: '
        .'cnpj = CNPJ do ESTABELECIMENTO EMITENTE (quem vendeu ou prestou o serviço), só os 14 dígitos; nunca o CPF ou CNPJ do consumidor/tomador. '
        .'razao_social = nome do emitente. '
        .'valor = valor TOTAL pago ou a pagar do documento, em reais, como número JSON com ponto decimal (ex.: 123.45); não some itens e não use troco, desconto nem tributos. '
        .'data = data de EMISSÃO no formato AAAA-MM-DD. '
        .'numero e serie = somente o número e a série do documento, um único número cada. '
        .'chave = chave de acesso de 44 dígitos (NF-e/NFC-e), somente se estiver impressa e totalmente legível. '
        .'chave_nfse = se a chave impressa tiver 50 dígitos (NFS-e nacional), escreva os 50 dígitos aqui e deixe chave null. '
        .'Use null em todo campo que não esteja legível com segurança. Não invente, corte nem complete dígitos. '
        .'Não escreva o CPF do consumidor em nenhum campo.';

    public function __construct(private VisaoIa $ia) {}

    public function disponivel(): bool
    {
        return $this->ia->disponivel();
    }

    /**
     * @return array<string, mixed>|null null = a IA não respondeu (sem chave, rede, saldo, recusa);
     *                                   senão as oito chaves de CAMPOS, cada uma já validada ou null
     */
    public function ler(string $bytes, string $mime = 'image/jpeg'): ?array
    {
        $texto = $this->ia->perguntar(
            'nota',
            (string) config('petermann.anthropic.modelo_nota'),
            $bytes,
            $mime,
            self::PROMPT,
            1500,
            (string) config('petermann.anthropic.effort_nota'),
            25,
        );

        return $texto === null ? null : $this->validar($texto);
    }

    /** Extrai o JSON do texto do modelo e confere cada campo. Sempre devolve as chaves de CAMPOS. */
    public function validar(string $texto): array
    {
        $out = array_fill_keys(self::CAMPOS, null);
        if (! preg_match('/\{.*\}/s', $texto, $m)) {
            return $out;
        }
        $j = json_decode($m[0], true);
        if (! is_array($j)) {
            return $out;
        }

        $chave = $this->soDigitos($j['chave'] ?? null);
        if ($chave !== null && strlen($chave) === 44 && $this->chaveValida($chave) && $this->chavePlausivel($chave)) {
            $out['chave'] = $chave;
        }
        $nfse = $this->soDigitos($j['chave_nfse'] ?? null);
        if ($nfse !== null && strlen($nfse) === 50 && $this->chaveNfsePlausivel($nfse)) {
            $out['chave_nfse'] = $nfse;
        }

        $cnpj = $this->soDigitos($j['cnpj'] ?? null);
        if ($cnpj !== null && strlen($cnpj) === 14 && $this->cnpjValido($cnpj)) {
            $out['cnpj'] = $cnpj;
        }
        $rs = $j['razao_social'] ?? null;
        if (is_string($rs)) {
            $rs = trim(preg_replace('/\s+/u', ' ', $rs));
            $out['razao_social'] = ($rs !== '' && mb_strlen($rs) <= 120) ? $rs : null;
        }
        /* a chave tem dígito verificador próprio: se ela confere, o CNPJ dela vale mais que o lido solto —
           e se o CNPJ lido era OUTRO, a razão social lida era dessa outra empresa */
        if ($out['chave'] !== null) {
            $doChave = substr($out['chave'], 6, 14);
            if ($this->cnpjValido($doChave)) {
                if ($out['cnpj'] !== null && $out['cnpj'] !== $doChave) {
                    $out['razao_social'] = null;
                }
                $out['cnpj'] = $doChave;
            }
        }

        $out['valor'] = $this->valor($j['valor'] ?? null);
        $out['data'] = $this->data($j['data'] ?? null);
        /* a data de emissão cai no mês da chave (AAMM): dia e mês trocados passam no formato mas não aqui */
        if ($out['data'] !== null && $out['chave'] !== null && substr($out['data'], 2, 2).substr($out['data'], 5, 2) !== substr($out['chave'], 2, 4)) {
            $out['data'] = null;
        }

        $out['numero'] = $this->grupoDeDigitos($j['numero'] ?? null, 9, true);
        $out['serie'] = $this->grupoDeDigitos($j['serie'] ?? null, 3, false);

        return $out;
    }

    private function soDigitos(mixed $v): ?string
    {
        if (! is_string($v) && ! is_int($v)) {
            return null;
        }
        $d = preg_replace('/\D/', '', (string) $v);

        return $d === '' ? null : $d;
    }

    /** Aceita UM grupo de dígitos (com "Nº" na frente ou ponto de milhar). "2026/123" ou "A1" não viram outro número. */
    private function grupoDeDigitos(mixed $v, int $max, bool $positivo): ?string
    {
        if (is_int($v)) {
            $v = (string) $v;
        }
        if (! is_string($v) || ! preg_match('/^\s*(?:n[º°o.]*\s*)?(\d{1,3}(?:\.\d{3})+|\d+)\s*$/iu', $v, $m)) {
            return null;
        }
        $d = str_replace('.', '', $m[1]);
        if (strlen($d) > $max || ($positivo && (int) $d <= 0)) {
            return null;
        }
        $d = ltrim($d, '0');

        return $d === '' ? '0' : $d;
    }

    private function valor(mixed $v): ?float
    {
        if (is_string($v)) {
            $s = trim(str_ireplace(['R$', ' '], '', $v));
            if ($s === '' || ! preg_match('/^\d[\d.,]*$/', $s)) {
                return null;
            }
            if (preg_match('/[.,]/', $s)) {
                /* o separador decimal é o ÚLTIMO "." ou "," e só vale com 1 ou 2 dígitos depois;
                   "1.234" e "12,345" são ambíguos (milhar ou decimal?) — melhor null que um valor 1000x errado */
                $p = max((int) strrpos($s, ','), (int) strrpos($s, '.'));
                $int = substr($s, 0, $p);
                $dec = substr($s, $p + 1);
                if (! preg_match('/^\d{1,2}$/', $dec)
                    || ! preg_match('/^\d+$|^\d{1,3}([.,]\d{3})+$/', $int)
                    || (str_contains($int, '.') && str_contains($int, ','))) {
                    return null;
                }
                $s = preg_replace('/\D/', '', $int).'.'.$dec;
            }
            $v = $s;
        }
        if (! is_numeric($v)) {
            return null;
        }
        $f = round((float) $v, 2);

        return ($f > 0 && $f < 1000000) ? $f : null;
    }

    private function data(mixed $v): ?string
    {
        if (! is_string($v) || ! preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) {
            return null;
        }
        $tz = new DateTimeZone('America/Sao_Paulo');
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $v, $tz);
        if (! $d || $d->format('Y-m-d') !== $v) {          // 2026-02-31 etc.
            return null;
        }
        $amanha = (new DateTimeImmutable('now', $tz))->modify('+1 day')->setTime(23, 59, 59);

        return ($d >= new DateTimeImmutable('2000-01-01', $tz) && $d <= $amanha) ? $v : null;
    }

    public function cnpjValido(string $c): bool
    {
        if (strlen($c) !== 14 || preg_match('/^(\d)\1{13}$/', $c)) {
            return false;
        }
        foreach ([12 => [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], 13 => [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]] as $pos => $pesos) {
            $soma = 0;
            foreach ($pesos as $i => $p) {
                $soma += (int) $c[$i] * $p;
            }
            $r = $soma % 11;
            if ((int) $c[$pos] !== ($r < 2 ? 0 : 11 - $r)) {
                return false;
            }
        }

        return true;
    }

    public function chaveValida(string $c): bool
    {
        if (strlen($c) !== 44) {
            return false;
        }
        $soma = 0;
        $peso = 2;
        for ($i = 42; $i >= 0; $i--) {
            $soma += (int) $c[$i] * $peso;
            $peso = $peso === 9 ? 2 : $peso + 1;
        }
        $r = $soma % 11;

        return (int) $c[43] === ($r < 2 ? 0 : 11 - $r);
    }

    /** O dígito verificador sozinho deixa passar ~10% das chaves aleatórias; aqui entram UF, AAMM, modelo e CNPJ embutido. */
    public function chavePlausivel(string $c): bool
    {
        if (! in_array(substr($c, 0, 2), self::UFS, true)) {
            return false;
        }
        $ano = 2000 + (int) substr($c, 2, 2);
        $mes = (int) substr($c, 4, 2);
        $hoje = new DateTimeImmutable('now', new DateTimeZone('America/Sao_Paulo'));
        if ($mes < 1 || $mes > 12 || $ano < 2006 || $ano > (int) $hoje->format('Y') + 1) {
            return false;
        }
        if (! in_array(substr($c, 20, 2), ['55', '65', '59'], true)) {
            return false;
        }
        $emitente = substr($c, 6, 14);

        return $this->cnpjValido($emitente) || str_starts_with($emitente, '000');   // 000 + CPF: NF-e de produtor rural
    }

    /** Mesma checagem estrutural do NFCE.parseChaveNfse50 do app. */
    public function chaveNfsePlausivel(string $c): bool
    {
        if (strlen($c) !== 50 || ! in_array(substr($c, 0, 2), self::UFS, true) || ! in_array($c[8], ['1', '2'], true)) {
            return false;
        }
        $ano = 2000 + (int) substr($c, 36, 2);
        $mes = (int) substr($c, 38, 2);
        $hoje = new DateTimeImmutable('now', new DateTimeZone('America/Sao_Paulo'));

        return $mes >= 1 && $mes <= 12 && $ano >= 2023 && $ano <= (int) $hoje->format('Y') + 1;
    }
}
