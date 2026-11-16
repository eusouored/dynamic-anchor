// Instalador padrão da família Dynamic (Windows).
// O mesmo código serve aos três plugins; o que muda vem de Config.cs, gerado por gerar_instalador.py
// a partir de um JSON por plugin. Recursos embutidos: payload, logo.png, licenca.txt, terceiros.txt.
//
// Fluxo: Boas-vindas → Licença (aceite obrigatório, aviso do que não segue a licença)
//        → Opções (só se o plugin tiver) → Instalação.
// Modos:
//   "pacote": payload é um .ccx (UXP) ou .zxp assinado (CEP), instalado pelo agente oficial da
//             Adobe (UnifiedPluginInstallerAgent, do Creative Cloud).
//   "script": payload é um .zip com scripts, motor e painel; é extraído em %LOCALAPPDATA%\<pasta> e
//             o script de instalação roda com o progresso na janela. Depois, atalhos no Menu Iniciar e
//             a entrada em Configurações > Aplicativos.
// Opção "modo dev" (CEP com certificado próprio): liga o PlayerDebugMode do Adobe CEP só para o usuário.
// Testes sem instalar:  --extrair <pasta>   --captura <pasta>
// Compilado com o csc do .NET Framework 4 (C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DynamicSetup
{
    static class Program
    {
        public const string Agente = @"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe";

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--extrair")
            {
                Extrair(args[1]);
                File.WriteAllText(Path.Combine(args[1], "licenca.txt"), Recurso("licenca.txt"), new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(args[1], "terceiros.txt"), Recurso("terceiros.txt"), new UTF8Encoding(false));
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 2 && args[0] == "--captura")
            {
                Directory.CreateDirectory(args[1]);
                new Janela().Capturar(args[1]);
                return 0;
            }
            Application.Run(new Janela());
            return 0;
        }

        public static string Recurso(string nome)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(nome))
            using (StreamReader r = new StreamReader(s, Encoding.UTF8))
                return r.ReadToEnd();
        }

        public static string Extrair(string pasta)
        {
            Directory.CreateDirectory(pasta);
            string destino = Path.Combine(pasta, Config.Pacote);
            using (Stream origem = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload"))
            using (FileStream arquivo = File.Create(destino))
                origem.CopyTo(arquivo, 1 << 20);
            return destino;
        }

        // modo "pacote": 0 = instalado pelo agente; -1 = entregue ao Creative Cloud; outro = erro do agente
        public static int InstalarPacote(string pacote, out string saida)
        {
            if (!File.Exists(Agente))
            {
                Process.Start(new ProcessStartInfo(pacote) { UseShellExecute = true });
                saida = "O instalador da Adobe não foi encontrado; o pacote foi aberto para o Creative Cloud instalar.";
                return -1;
            }
            ProcessStartInfo info = new ProcessStartInfo(Agente, "/install \"" + pacote + "\"");
            info.UseShellExecute = false; info.RedirectStandardOutput = true; info.RedirectStandardError = true; info.CreateNoWindow = true;
            using (Process p = Process.Start(info))
            {
                string o = p.StandardOutput.ReadToEnd(), e = p.StandardError.ReadToEnd();
                p.WaitForExit();
                saida = (o + Environment.NewLine + e).Trim();
                return p.ExitCode;
            }
        }

        // Login da Hugging Face já salvo neste usuário (HF_TOKEN, ou o arquivo "token" em HF_HOME / ~\.cache\huggingface).
        // Só confere se existe; o conteúdo não é lido.
        public static bool TemContaHF()
        {
            try
            {
                if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HF_TOKEN"))) return true;
                string home = Environment.GetEnvironmentVariable("HF_HOME");
                if (string.IsNullOrEmpty(home))
                    home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "huggingface");
                return File.Exists(Path.Combine(home, "token"));
            }
            catch { return false; }
        }

        // modo "script": extrai o .zip para %LOCALAPPDATA%\<pasta> e roda o script, linha a linha
        public static int InstalarScript(string zip, bool pessoal, bool python, string token, Action<string> linha)
        {
            string alvo = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Config.ScriptPasta);
            if (Directory.Exists(alvo)) Directory.Delete(alvo, true);
            Directory.CreateDirectory(alvo);
            ZipFile.ExtractToDirectory(zip, alvo);
            string args = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(alvo, Config.ScriptInstalar) + "\" -SemPerguntas " +
                          (pessoal ? "-UsoPessoal" : "-UsoComercial") + (python ? " -InstalarPython" : "");
            ProcessStartInfo info = new ProcessStartInfo("powershell.exe", args);
            info.UseShellExecute = false; info.RedirectStandardOutput = true; info.RedirectStandardError = true; info.CreateNoWindow = true;
            info.WorkingDirectory = alvo;
            Encoding oem = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage);
            info.StandardOutputEncoding = oem; info.StandardErrorEncoding = oem;
            if (!string.IsNullOrEmpty(token)) info.EnvironmentVariables["DC_HF_TOKEN"] = token;  // nunca pela linha de comando
            using (Process p = new Process())
            {
                p.StartInfo = info;
                p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) linha(e.Data); };
                p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) linha(e.Data); };
                p.Start(); p.BeginOutputReadLine(); p.BeginErrorReadLine();
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        // atalhos do Menu Iniciar e a entrada em Configurações > Aplicativos (modo "script")
        public static void Registrar()
        {
            string alvo = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Config.ScriptPasta);
            string desinstalar = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(alvo, Config.ScriptDesinstalar) + "\" -SemPerguntas";
            string icone = Path.Combine(alvo, Config.ScriptIcone);
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Config.Nome);
            Directory.CreateDirectory(menu);
            Type tipo = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(tipo);
            for (int i = 0; i < Config.Atalhos.Length; i += 2)
            {
                object lnk = tipo.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(menu, Config.Atalhos[i] + ".lnk") });
                Type t = lnk.GetType();
                if (Config.Atalhos[i + 1] == "*desinstalar")
                {
                    t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { "powershell.exe" });
                    t.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { desinstalar.Replace(" -SemPerguntas", "") });
                }
                else t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { Path.Combine(alvo, Config.Atalhos[i + 1]) });
                t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { alvo });
                if (File.Exists(icone)) t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icone });
                t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            }
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Config.ScriptChave))
            {
                k.SetValue("DisplayName", Config.Nome);
                k.SetValue("DisplayVersion", Config.Versao);
                k.SetValue("Publisher", "Dynamic");
                k.SetValue("InstallLocation", Path.GetDirectoryName(alvo));
                if (File.Exists(icone)) k.SetValue("DisplayIcon", icone);
                k.SetValue("UninstallString", "powershell.exe " + desinstalar);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        // PlayerDebugMode do Adobe CEP, só para este usuário (versões 9 a 14)
        public static void LigarModoDev()
        {
            for (int v = 9; v <= 14; v++)
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Adobe\CSXS." + v))
                    k.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
        }
    }

    class Janela : Form
    {
        static readonly Color Grafite = ColorTranslator.FromHtml("#1B1B1F");
        static readonly Color Poco = ColorTranslator.FromHtml("#141417");
        static readonly Color Superficie = ColorTranslator.FromHtml("#2A2A30");
        static readonly Color Linha = ColorTranslator.FromHtml("#2E2E35");
        static readonly Color Papel = ColorTranslator.FromHtml("#F5F3F0");
        static readonly Color Cinza = ColorTranslator.FromHtml("#B8B3AC");
        static readonly Color Cinza3 = ColorTranslator.FromHtml("#85807A");
        static readonly Color Aviso = ColorTranslator.FromHtml("#F2C14E");
        static readonly Color AvisoFundo = ColorTranslator.FromHtml("#352F25");
        static readonly Color Acento = ColorTranslator.FromHtml(Config.Acento);
        static readonly Color TintaAcento = ColorTranslator.FromHtml(Config.TintaAcento);
        const int M = 32, L = 600, A = 500;
        static readonly bool TemOpcoes = Config.OpcoesUso || Config.ModoDev;

        readonly List<Panel> paginas = new List<Panel>();
        readonly List<Label> passos = new List<Label>();
        readonly Button voltar = new Button(), proximo = new Button(), cancelar = new Button();
        readonly CheckBox aceito = new CheckBox(), python = new CheckBox(), modoDev = new CheckBox();
        readonly RadioButton pessoal = new RadioButton(), pago = new RadioButton();
        readonly TextBox token = new TextBox(), registro = new TextBox();
        readonly Label estado = new Label(), detalhe = new Label();
        readonly ProgressBar barra = new ProgressBar();
        int pagina, paginaInstalar;
        bool instalado, rodando;

        public Janela()
        {
            Text = "Instalar " + Config.Nome + " " + Config.Versao;
            Font = new Font("Segoe UI", 9.5f);
            BackColor = Grafite; ForeColor = Papel;
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; ClientSize = new Size(L, A);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            FormClosing += delegate (object s, FormClosingEventArgs e) {
                if (rodando) { e.Cancel = true; MessageBox.Show(this, "A instalação ainda está em andamento. Espere terminar.", Config.Nome, MessageBoxButtons.OK, MessageBoxIcon.Information); }
            };

            PictureBox logo = new PictureBox { Size = new Size(44, 44), Location = new Point(M, 24), SizeMode = PictureBoxSizeMode.Zoom };
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png")) logo.Image = Image.FromStream(s);
            Controls.Add(logo);
            Controls.Add(new Label { Text = Config.Nome, Font = new Font("Segoe UI Semibold", 15f), AutoSize = true, Location = new Point(M + 56, 22) });
            Controls.Add(new Label { Text = "Versão " + Config.Versao + " · plugin " + Config.Tecnologia + " para o Adobe Premiere Pro", ForeColor = Cinza, AutoSize = true, Location = new Point(M + 58, 50) });

            List<string> nomes = new List<string> { "Boas-vindas", "Licença" };
            if (TemOpcoes) nomes.Add("Opções");
            nomes.Add("Instalação");
            int larg = (L - 2 * M) / nomes.Count;
            for (int i = 0; i < nomes.Count; i++)
            {
                Label p = new Label { Text = (i + 1) + "  " + nomes[i], AutoSize = false, Size = new Size(larg - 8, 22), Location = new Point(M + i * larg, 84), Font = new Font("Segoe UI Semibold", 9f) };
                passos.Add(p); Controls.Add(p);
            }
            Controls.Add(new Panel { BackColor = Linha, Size = new Size(L - 2 * M, 1), Location = new Point(M, 110) });

            for (int i = 0; i < nomes.Count; i++)
            {
                Panel p = new Panel { Location = new Point(M, 122), Size = new Size(L - 2 * M, 300), BackColor = Grafite };
                paginas.Add(p); Controls.Add(p);
            }
            MontarBoasVindas(paginas[0]);
            MontarLicenca(paginas[1]);
            if (TemOpcoes) MontarOpcoes(paginas[2]);
            paginaInstalar = paginas.Count - 1;
            MontarInstalacao(paginas[paginaInstalar]);

            Controls.Add(new Panel { BackColor = Linha, Size = new Size(L, 1), Location = new Point(0, A - 66) });
            Estilo(cancelar, false); cancelar.Text = "Cancelar"; cancelar.Location = new Point(M, A - 50); cancelar.Click += delegate { Close(); };
            Estilo(voltar, false); voltar.Text = "Voltar"; voltar.Location = new Point(L - M - 150 - 8 - 110, A - 50); voltar.Click += delegate { Ir(pagina - 1); };
            Estilo(proximo, true); proximo.Location = new Point(L - M - 150, A - 50); proximo.Click += delegate { Avancar(); };
            Controls.Add(cancelar); Controls.Add(voltar); Controls.Add(proximo);
            AcceptButton = proximo;
            Ir(0);
        }

        static void Estilo(Button b, bool principal)
        {
            b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0;
            b.Size = new Size(principal ? 150 : 110, 36);
            b.Font = new Font(principal ? "Segoe UI Semibold" : "Segoe UI", 9.5f);
            b.BackColor = principal ? Acento : Superficie; b.ForeColor = principal ? TintaAcento : Papel;
            b.Cursor = Cursors.Hand;
        }

        void MontarBoasVindas(Panel p)
        {
            p.Controls.Add(new Label { Text = Config.Descricao, Location = new Point(0, 4), Size = new Size(p.Width, 44) });
            p.Controls.Add(new Label { Text = "O que será instalado", Font = new Font("Segoe UI Semibold", 9.5f), AutoSize = true, Location = new Point(0, 58) });
            int y = 84;
            foreach (string item in Config.Itens)
            {
                p.Controls.Add(new Panel { BackColor = Acento, Size = new Size(6, 6), Location = new Point(2, y + 8) });
                p.Controls.Add(new Label { Text = item, Location = new Point(18, y), Size = new Size(p.Width - 18, 22) });
                y += 26;
            }
            p.Controls.Add(new Label { Text = "Requisitos", Font = new Font("Segoe UI Semibold", 9.5f), AutoSize = true, Location = new Point(0, y + 14) });
            p.Controls.Add(new Label { Text = Config.Requisitos, ForeColor = Cinza, Location = new Point(0, y + 40), Size = new Size(p.Width, 62) });
        }

        void MontarLicenca(Panel p)
        {
            int topo = 0;
            if (!string.IsNullOrEmpty(Config.Aviso))
            {
                Panel caixa = new Panel { BackColor = AvisoFundo, Location = new Point(0, 0), Size = new Size(p.Width, 90) };
                caixa.Controls.Add(new Panel { BackColor = Aviso, Location = new Point(0, 0), Size = new Size(3, 90) });
                caixa.Controls.Add(new Label { Text = "Atenção: nem tudo no pacote segue a licença do " + Config.Nome, ForeColor = Aviso, Font = new Font("Segoe UI Semibold", 9f), Location = new Point(14, 8), Size = new Size(p.Width - 24, 18) });
                caixa.Controls.Add(new Label { Text = Config.Aviso, ForeColor = Papel, Font = new Font("Segoe UI", 8.5f), Location = new Point(14, 28), Size = new Size(p.Width - 24, 58) });
                p.Controls.Add(caixa);
                topo = 100;
            }
            TextBox texto = new TextBox
            {
                Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = true,
                BorderStyle = BorderStyle.None, BackColor = Poco, ForeColor = Papel, Font = new Font("Consolas", 8.5f),
                Location = new Point(0, topo), Size = new Size(p.Width, 262 - topo)
            };
            texto.Text = (Program.Recurso("licenca.txt") + "\r\n\r\n" + Program.Recurso("terceiros.txt")).Replace("\r\n", "\n").Replace("\n", "\r\n");
            p.Controls.Add(texto);
            aceito.Text = "Li e aceito a licença do " + Config.Nome + " e as licenças dos componentes de terceiros.";
            aceito.ForeColor = Papel; aceito.AutoSize = false; aceito.Size = new Size(p.Width, 24); aceito.Location = new Point(0, 272);
            aceito.CheckedChanged += delegate { Botoes(); };
            p.Controls.Add(aceito);
        }

        void MontarOpcoes(Panel p)
        {
            int y = 0;
            if (Config.OpcoesUso)
            {
                p.Controls.Add(new Label { Text = "Como o " + Config.Nome + " vai ser usado neste computador?", Font = new Font("Segoe UI Semibold", 9.5f), AutoSize = true, Location = new Point(0, y) });
                y += 28;
                pessoal.Text = "Uso pessoal, sem cobrar por isso"; pessoal.AutoSize = true; pessoal.Location = new Point(0, y); pessoal.Checked = true;
                p.Controls.Add(pessoal);
                p.Controls.Add(new Label { Text = "SUPlime, o separador de vozes mais preciso (licença não comercial). Precisa de conta grátis na Hugging Face; sem token, usa o mesmo separador do trabalho pago.", ForeColor = Cinza, Location = new Point(20, y + 22), Size = new Size(p.Width - 20, 32), Font = new Font("Segoe UI", 8.5f) });
                y += 58;
                pago.Text = "Trabalho pago ou clientes"; pago.AutoSize = true; pago.Location = new Point(0, y);
                p.Controls.Add(pago);
                p.Controls.Add(new Label { Text = "Separação de vozes com licença comercial; não precisa de conta em site nenhum.", ForeColor = Cinza, Location = new Point(20, y + 22), Size = new Size(p.Width - 20, 18), Font = new Font("Segoe UI", 8.5f) });
                y += 52;
                // Conta da Hugging Face já configurada neste computador (login salvo): o token pode ficar em branco.
                bool temConta = Program.TemContaHF();
                Label rotulo = new Label { AutoSize = false, Size = new Size(p.Width, 20), Location = new Point(0, y) };
                p.Controls.Add(rotulo);
                Button como = new Button(); Estilo(como, false); como.Text = "Como conseguir"; como.Size = new Size(130, 26);
                como.Location = new Point(p.Width - 130, y + 22);
                como.Click += delegate { ComoConseguir(); };
                p.Controls.Add(como);
                token.UseSystemPasswordChar = true; token.BorderStyle = BorderStyle.FixedSingle; token.BackColor = Poco; token.ForeColor = Papel;
                token.Location = new Point(0, y + 22); token.Size = new Size(p.Width - 140, 26);
                p.Controls.Add(token);
                // O campo tem cores próprias: desligado, ele parecia igual e só não aceitava digitar. Agora muda de cara e o texto diz por quê.
                MethodInvoker atualizar = delegate
                {
                    bool liga = pessoal.Checked;
                    token.Enabled = liga; como.Enabled = liga;
                    token.BackColor = liga ? Poco : Grafite;
                    como.ForeColor = liga ? Papel : Cinza3;
                    rotulo.ForeColor = liga ? Papel : Cinza3;
                    rotulo.Text = !liga ? "Token: só no uso pessoal (o SUPlime não vale para trabalho pago)"
                        : temConta ? "Token (hf_...): opcional. Este computador já tem conta da Hugging Face configurada."
                        : "Token (hf_...): opcional, libera o SUPlime";
                };
                pessoal.CheckedChanged += delegate { atualizar(); };
                atualizar();
                y += 56;
                python.Text = "Instalar o Python 3.12 oficial, se ele não estiver neste computador (pelo winget)";
                python.Checked = true; python.AutoSize = false; python.Size = new Size(p.Width, 24); python.Location = new Point(0, y);
                p.Controls.Add(python);
                y += 30;
            }
            if (Config.ModoDev)
            {
                modoDev.Text = "Ligar o carregamento de extensões com certificado próprio (PlayerDebugMode)";
                modoDev.Checked = true; modoDev.AutoSize = false; modoDev.Size = new Size(p.Width, 24); modoDev.Location = new Point(0, y);
                p.Controls.Add(modoDev);
                p.Controls.Add(new Label { Text = "O painel é assinado com certificado próprio; sem isso, o Premiere pode não mostrá-lo. Muda um valor no Registro só do seu usuário (HKCU\\Software\\Adobe\\CSXS.9 a 14 › PlayerDebugMode = 1).", ForeColor = Cinza, Location = new Point(20, y + 24), Size = new Size(p.Width - 20, 52), Font = new Font("Segoe UI", 8.5f) });
            }
        }

        // Os passos para liberar o SUPlime (vinham do instalador antigo e se perderam no instalador padrão).
        void ComoConseguir()
        {
            DialogResult r = MessageBox.Show(this,
                "Para usar o SUPlime (grátis, uns 5 minutos, uma vez só):\r\n\r\n" +
                "1. Crie uma conta em huggingface.co e confirme o e-mail.\r\n" +
                "2. Na página do SUPlime (vai abrir agora), entre na conta e aceite as condições.\r\n" +
                "3. Na página de tokens (vai abrir agora), crie um token do tipo Read e copie o código que começa com hf_.\r\n" +
                "4. Cole o código no campo Token deste instalador.\r\n\r\n" +
                "O token é pessoal: não compartilhe.",
                Config.Nome, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (r != DialogResult.OK) return;
            foreach (string url in new[] { "https://huggingface.co/rewayai/suplime", "https://huggingface.co/settings/tokens" })
            {
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
            }
            token.Focus();
        }

        void MontarInstalacao(Panel p)
        {
            estado.Font = new Font("Segoe UI Semibold", 11f); estado.Location = new Point(0, 4); estado.Size = new Size(p.Width, 26);
            detalhe.ForeColor = Cinza; detalhe.Location = new Point(0, 34); detalhe.Size = new Size(p.Width, 54);
            barra.Style = ProgressBarStyle.Marquee; barra.MarqueeAnimationSpeed = 30; barra.Location = new Point(0, 92); barra.Size = new Size(p.Width, 6); barra.Visible = false;
            registro.Multiline = true; registro.ReadOnly = true; registro.ScrollBars = ScrollBars.Vertical; registro.WordWrap = true;
            registro.BorderStyle = BorderStyle.None; registro.BackColor = Poco; registro.ForeColor = Cinza; registro.Font = new Font("Consolas", 8.5f);
            registro.Location = new Point(0, 108); registro.Size = new Size(p.Width, 188); registro.Visible = Config.Modo == "script";
            p.Controls.Add(estado); p.Controls.Add(detalhe); p.Controls.Add(barra); p.Controls.Add(registro);
        }

        void Ir(int n)
        {
            if (n < 0 || n >= paginas.Count) return;
            pagina = n;
            for (int i = 0; i < paginas.Count; i++) { paginas[i].Visible = i == n; passos[i].ForeColor = i == n ? Papel : Cinza3; }
            Botoes();
        }

        void Botoes()
        {
            bool naLicenca = pagina == 1, ultimaAntes = pagina == paginaInstalar - 1;
            voltar.Visible = pagina > 0 && pagina < paginaInstalar && !rodando;
            if (pagina == paginaInstalar) proximo.Text = instalado ? "Concluir" : "Tentar de novo";
            else proximo.Text = ultimaAntes ? "Instalar" : "Próximo";
            proximo.Enabled = !(naLicenca && !aceito.Checked);
            proximo.BackColor = proximo.Enabled ? Acento : Superficie;
            proximo.ForeColor = proximo.Enabled ? TintaAcento : Cinza3;
            proximo.Visible = pagina != paginaInstalar || (!rodando && estado.Text.Length > 0);
        }

        void Avancar()
        {
            if (pagina == paginaInstalar && instalado) { Close(); return; }
            if (pagina < paginaInstalar - 1) { Ir(pagina + 1); return; }
            if (!aceito.Checked) return;
            if (Config.OpcoesUso && pessoal.Checked)
            {
                string t0 = token.Text.Trim();
                if (t0.Length > 0 && !t0.StartsWith("hf_"))
                {
                    MessageBox.Show(this, "O token da Hugging Face começa com hf_. Confira se copiou o código inteiro (ou deixe o campo em branco).", Config.Nome, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    token.Focus(); token.SelectAll();
                    return;
                }
            }
            Ir(paginaInstalar);
            rodando = true; Botoes(); cancelar.Enabled = false;
            estado.ForeColor = Papel; estado.Text = "Instalando…";
            detalhe.Text = Config.Modo == "script" ? "Baixando e preparando o que este computador precisa. Na primeira vez leva de 20 a 40 minutos." : "Copiando o pacote e chamando o instalador da Adobe. Pode levar um minuto.";
            barra.Visible = true; registro.Text = "";
            bool usoPessoal = !Config.OpcoesUso || pessoal.Checked, instalarPython = python.Checked, dev = Config.ModoDev && modoDev.Checked;
            string tok = Config.OpcoesUso && pessoal.Checked ? token.Text.Trim() : "";
            Thread t = new Thread(delegate ()
            {
                int codigo; string saida = "";
                try
                {
                    string pacote = Program.Extrair(Path.Combine(Path.GetTempPath(), "DynamicSetup"));
                    if (Config.Modo == "script")
                    {
                        codigo = Program.InstalarScript(pacote, usoPessoal, instalarPython, tok, AoLer);
                        if (codigo == 0) Program.Registrar();
                    }
                    else codigo = Program.InstalarPacote(pacote, out saida);
                    if ((codigo == 0 || codigo == -1) && dev) Program.LigarModoDev();
                }
                catch (Exception ex) { codigo = -2; saida = ex.Message; }
                BeginInvoke((MethodInvoker)delegate { Terminar(codigo, saida); });
            });
            t.IsBackground = true; t.Start();
        }

        void AoLer(string texto)
        {
            BeginInvoke((MethodInvoker)delegate
            {
                string s = texto.TrimEnd();
                if (s.StartsWith("== ")) detalhe.Text = s.Substring(3);
                registro.AppendText(s + "\r\n");
                if (registro.Lines.Length > 400) registro.Lines = registro.Lines.Skip(registro.Lines.Length - 300);
            });
        }

        public void Capturar(string pasta)
        {
            StartPosition = FormStartPosition.Manual; Location = new Point(-4000, -4000); ShowInTaskbar = false;
            Show(); Application.DoEvents();
            Action<string> foto = delegate (string nome)
            {
                Refresh(); Application.DoEvents();
                using (Bitmap b = new Bitmap(Width, Height)) { DrawToBitmap(b, new Rectangle(0, 0, Width, Height)); b.Save(Path.Combine(pasta, nome), System.Drawing.Imaging.ImageFormat.Png); }
            };
            Ir(0); foto("1-boas-vindas.png");
            Ir(1); aceito.Checked = true; foto("2-licenca.png");
            if (TemOpcoes) { Ir(2); foto("3-opcoes.png"); }
            if (Config.OpcoesUso) { pago.Checked = true; foto("3b-opcoes-trabalho-pago.png"); pessoal.Checked = true; }
            Ir(paginaInstalar); rodando = true; estado.Text = "Instalando…"; barra.Visible = true;
            detalhe.Text = "Modelos de transcrição e de vozes (vários GB na primeira vez)";
            registro.Text = "Dynamic Captions 0.3.0 - instalador\r\n== Python\r\n   Python 3.12 encontrado\r\n== Encerrando o motor em uso, se estiver aberto\r\n   nenhum motor em execução\r\n== Modelos de transcrição e de vozes\r\n   baixando Qwen3-ASR-1.7B… 38%";
            Botoes(); foto("4-instalando.png");
            rodando = false; Terminar(0, ""); foto("4-pronto.png");
            Terminar(2, ""); foto("4-bloqueado.png");
        }

        void Terminar(int codigo, string saida)
        {
            rodando = false; barra.Visible = false;
            cancelar.Enabled = true; cancelar.Text = "Fechar";
            instalado = codigo == 0 || codigo == -1;
            cancelar.Visible = !instalado;
            if (codigo == 0)
            {
                estado.ForeColor = Acento; estado.Text = "Pronto";
                detalhe.Text = "Abra o Adobe Premiere Pro e procure o painel " + Config.Nome + " no menu Janela. Se o Premiere estava aberto, reinicie-o.";
            }
            else if (codigo == -1) { estado.ForeColor = Papel; estado.Text = "Quase lá"; detalhe.Text = "O Creative Cloud vai concluir a instalação. Siga a janela dele."; }
            else if (codigo == 2 && Config.Modo == "script")
            {
                estado.ForeColor = Aviso; estado.Text = "Bloqueado pelo Windows";
                detalhe.Text = "O Controle Inteligente de Aplicativos do Windows bloqueou bibliotecas do motor. Nada foi trocado. Veja \"SE DER ERRADO\" no LEIA-ME.txt.";
            }
            else
            {
                estado.ForeColor = Aviso; estado.Text = "A instalação não terminou (código " + codigo + ")";
                detalhe.Text = string.IsNullOrEmpty(saida) ? (Config.Modo == "script" ? "Veja o registro abaixo." : "O instalador da Adobe não deu detalhes.") : saida;
            }
            Botoes(); proximo.Visible = true;
            // registro rolado até o fim, sem texto selecionado; foco no botão principal
            registro.SelectionStart = registro.TextLength; registro.SelectionLength = 0; registro.ScrollToCaret();
            proximo.Focus();
        }
    }

    static class Extensoes
    {
        public static string[] Skip(this string[] a, int n) { string[] r = new string[Math.Max(0, a.Length - n)]; Array.Copy(a, n, r, 0, r.Length); return r; }
    }
}
