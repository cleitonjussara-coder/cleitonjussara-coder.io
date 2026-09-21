<?php

namespace App\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Cookie\CookieJar;
use Throwable;

/**
 * Lê o VALOR (e data/emitente) da NFC-e abrindo a MESMA URL que o QR do
 * cupom traz — a única que os portais aceitam, porque já vem com o hash
 * assinado pelo emitente. O app faz isso pelo servidor porque o navegador
 * não pode ler o HTML de outro domínio (CORS) e porque alguns portais
 * exigem cookie de sessão entre dois passos (GO).
 *
 * Verificado em 16/09/2026 com cupom real: BA (nfe.sefaz.ba.gov.br) devolve
 * o DANFE no primeiro GET, desde que os cookies acompanhem o redirect; GO
 * (nfeweb.sefaz.go.gov.br) devolve só um esqueleto e o DANFE vem de
 * /nfeweb/sites/nfce/render/html/danfeNFCe?chNFe=<chave> na mesma sessão.
 *
 * Sondados em 16/09/2026 SEM cupom real (chave válida, hash falso — o portal
 * respondeu até a validação da chave, então a página do DANFE é a genérica):
 *   MT  www.sefaz.mt.gov.br/nfce/consultanfce     — exige "|" como %7C (400 se cru)
 *   MG  portalsped.fazenda.mg.gov.br/.../qrcode.xhtml — NÃO dá: confirmado com cupom real em
 *       20/09/2026 — a URL do QR abre um formulário JSF com captcha (Turnstile) e botão
 *       "Visualizar"; o DANFE só vem depois do desafio. Fica o OCR.
 *   SP  www.nfce.fazenda.sp.gov.br/qrcode → NFCeConsultaPublica/.../ConsultaQRCode.aspx — direta
 *   PR  www.fazenda.pr.gov.br/nfce/qrcode           — direta (ReceitaPR)
 *   RS  www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx → dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce — direta
 *       (ok da Locaweb em <1 s; um primeiro teste deu timeout — é instável, não bloqueado)
 *   TO  www.sefaz.to.gov.br/nfce/qrcode            — NÃO respondeu nem do PC nem da Locaweb
 *       (timeout 25 s, http e https). Conferir com cupom real; até lá fica o OCR.
 *   SC  sat.sef.sc.gov.br/nfce/consulta            — cai em tax.NET/SecurityVerify.aspx (verificação por
 *       JavaScript): NÃO dá para ler pelo servidor → fica o OCR
 * Confirmar cada um no primeiro cupom real; ver [[urls-consulta-nfe-nfce]].
 * É best-effort: qualquer falha devolve null e o app segue com o OCR.
 */
class SefazPorQr
{
    private const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';

    /** @return array{valor: ?float, data: ?string, cnpj: ?string, razao_social: ?string, fonte: string}|null */
    public function consultar(string $qrUrl, ?string $chave = null): ?array
    {
        $qrUrl = trim($qrUrl);
        $host = strtolower((string) parse_url($qrUrl, PHP_URL_HOST));
        /* só portais de governo — evita o servidor virar proxy aberto */
        if (! preg_match('~^https?://~i', $qrUrl) || ! str_ends_with($host, '.gov.br')) {
            return null;
        }
        $chave = preg_replace('/\D/', '', (string) $chave);
        /* o "|" cru do QR derruba alguns portais (MT: 400); percent-encoded
           todos aceitam */
        $qrUrl = str_replace(['|', ' '], ['%7C', '%20'], $qrUrl);

        try {
            $jar = new CookieJar;
            $http = new Client([
                'timeout' => 20,          // BA leva ~12 s para montar o DANFE
                'connect_timeout' => 8,
                'cookies' => $jar,
                'allow_redirects' => ['max' => 6],
                'headers' => ['User-Agent' => self::UA, 'Accept-Language' => 'pt-BR,pt;q=0.9'],
                // Windows sem CA bundle no PHP: CA_BUNDLE no .env local; produção usa o do sistema
                'verify' => config('petermann.ca_bundle') ?: true,
            ]);
            $html = (string) $http->get($qrUrl)->getBody();

            /* GO: o DANFE vem num segundo pedido, na mesma sessão */
            if (str_contains($host, 'sefaz.go.gov.br') && strlen($chave) === 44) {
                $html = (string) $http->get("https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfce/render/html/danfeNFCe?chNFe={$chave}")->getBody();
            }
        } catch (Throwable) {
            return null;
        }

        $r = $this->extrair($html);
        if ($r['valor'] === null) {
            return null;
        }
        $r['fonte'] = 'sefaz:'.$host;

        return $r;
    }

    /** Texto plano do HTML (algumas páginas vêm escapadas duas vezes) e regex. */
    private function extrair(string $html): array
    {
        $t = html_entity_decode(html_entity_decode($html, ENT_QUOTES | ENT_HTML5, 'UTF-8'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $t = preg_replace('/<script\b[^>]*>.*?<\/script>/is', ' ', $t);
        $t = preg_replace('/<[^>]+>/', ' ', $t);
        $t = preg_replace('/\s+/u', ' ', $t);

        $valor = null;
        foreach ([
            '/Valor a pagar\s*R?\$?:?\s*([\d.]+,\d{2})/iu',
            '/Valor total\s*(?:da nota|R\$)?:?\s*([\d.]+,\d{2})/iu',
            '/VALOR TOTAL\s*R?\$?\s*([\d.]+,\d{2})/u',
            '/Total\s*R\$\s*([\d.]+,\d{2})/u',
        ] as $p) {
            if (preg_match($p, $t, $m)) {
                $valor = (float) str_replace(',', '.', str_replace('.', '', $m[1]));
                break;
            }
        }

        $data = null;
        if (preg_match('/Emiss[ãa]o:?\s*(\d{2})\/(\d{2})\/(\d{4})/iu', $t, $m)) {
            $data = "{$m[3]}-{$m[2]}-{$m[1]}";
        }

        $cnpj = null;
        $razao = null;
        if (preg_match('/(.{3,120}?)\s*CNPJ:?\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/u', $t, $m)) {
            $cnpj = preg_replace('/\D/', '', $m[2]);
            /* o nome do emitente é o que vem logo antes do CNPJ, depois do
               título do DANFE */
            $razao = trim(preg_replace('/^.*(?:ELETR[ÔO]NICA|NFC-e|CONSUMIDOR)\s*/iu', '', $m[1]));
            if (strlen($razao) < 3 || strlen($razao) > 120) {
                $razao = null;
            }
        }

        return ['valor' => $valor, 'data' => $data, 'cnpj' => $cnpj, 'razao_social' => $razao];
    }
}
