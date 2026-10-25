# M3 controller提取与补名收敛：本地原件归档

状态：2026-10-25 / `ARCHIVE_BYTES_VERIFIED_NOT_RELEASE`。这是实际代码、旧行为对照、真实失败及最终QA V3的归档，不是新配对性能、精确提交CI、M3 EXIT或发布证明。版本仍15.0.2，HEAD仍`170fd3eadc6da02750882f8a542904ee2358d0d9`，候选为该HEAD上的dirty工作树。

## 归档身份与核验

| 项目 | 实际结果 |
| --- | --- |
| `original-evidence.tar.gz` | 10,284,125 B |
| 压缩包SHA256 | `63ef139c550aa71f2d9e755ba77deb01e0b9351bfe6463a8d6add70e7caaa971` |
| 完整成员 | 844文件 / 解压21,026,354 B |
| sorted-JSON行SHA256 | `6b9f3e4c4e3c6c92868a0febfa62263bd4d51b93343eadfab9ef3e1ec265ca66` |
| tar创建与新目录解压 | 两次native0、stderr0；新解压每个路径/字节/SHA256与stage完全相同 |
| 原输入保护 | 9个原工作区、2个浏览器原件目录、281源、129产物、68安装库存及HEAD/branch/index前后未变 |

`archive-plan.json`列出所有成员与完整库存；`archive-audit.json`保存实际结果；`archive-tool.mjs.txt`是成功a3工具的完整源码。`archive-native/`为真实创建/解压及before/after Git命令收据和stdout/stderr。这些归档后审计、plan与本README为包外addendum；没有反向声称它们已在原包内。归档工具没有运行任何业务test/build/E2E/performance。

## 实际完成内容

- `sync-status.js`接管既有同步busy/pending/timer和UI编排，保留App动态注入、Schema3完整持仓fingerprint/meta与按需云客户端。旧App方法体是同步表征oracle，不是两个新wrapper互比。
- `pwa-update-controller.js`接管SW状态、banner、prepare/blocked跨页认证、dirty/drain、激活与reload；构造无listener副作用，原注册位置start。`update-compat.js`与原独立入口顺序保留。源码SW CORE与原五组build membership接入两新模块，生成CORE仍取实际chunks。
- 真实双controller互锁回归覆盖同步中拒绝更新、更新drain中拒绝新同步、dirty改变后恢复、精确ACK仅reload一次。
- 完整范围复核发现自动补名事务晚于cache flush：事务清掉刚写的新cache，暖刷新再次获取稳定资源；取消后旧saved/conflict/failure结果还可能安装到新App状态。原5个行为测试真实RED后，修复为每代跟踪补名Promise，等待资源/元数据及补名settle，再经原current gate唯一flush。补名reconcile不重复写cache，仓储事务cache失效规则未全局关闭；保存前/后signal gate保护新App。第6项真实`runRefresh`接线测试为修复后加入，不能称6项全部先红。

局限：原Web Lock排队本身没有新增可中止能力；取消不再写入/安装旧结果，但drain仍可能等待外部锁释放。回归测试释放了合成锁，不证明无限锁持有时的退出时限。

## 最终QA V3身份与结果

完整源281行SHA256：`8b93b2e2476757a381e3788f3f82428b54cfa26fae7fe6f3339a0896f8a71653`。App SHA `d40895881eb10188a8346dfb461918654d25c10cf2e19be9bbcc5516b04d0f3a`；executor SHA `e0dee7d21e503c6142aa0acf1f5f81b9c17fe7c1df2d8d3ed7067b410ecb574f`。`parent/QA_SOURCE_V3.json`及各gate真实before/after、命令、stdout/stderr/receipt均收录。

| 门禁 | 原生结果 |
| --- | --- |
| 全量单测 | 1412 total / 1409 PASS / 0 FAIL / 3既有Windows skip；native0 |
| 语法 | 223 JavaScript文件；native0 |
| 桌面Chrome E2E | 35/35；native0；stderr352B的NO_COLOR/FORCE_COLOR警告保留 |
| 两次构建 | 原ES2022/OXC/五加载组及epoch1792046773；完整129文件每项byte/SHA同 |
| 完整产物行SHA | `94bd2839eb13c06ae0000c98264587936d494eea3e3562786864f812bf5bf5ce` |
| 实际chunks/体积 | 16chunks/raw254560B；all86850/92160B，cold47014/52241B；独立CLI native0 |
| 图检查 | literal import closure/static bindings通过；`evaluated/startupOrderVerified/dynamicNamespaceMembersVerified`仍false，不能外推为运行时完整图证明 |
| OCR核验 | 23资源 / 88,196,906 B；仅资源检查，不是识别或真机验收 |
| 官方registry审计 | native0 / found 0 vulnerabilities；仅当前依赖状态 |

只有全部非OCR总包上限按用户授权改90KiB，冷启动和其他门禁不变。§58的旧800+4样本属于提取前274源，不继承到本轮281源；新的固定配对性能、不可变提交CI和完整M4–M6仍需完成。

## 包内路径

| 前缀 | 内容 |
| --- | --- |
| `parent/` | 原App备份、接线patch/工具、集成失败及GREEN、QA V1/V2/V3冻结源与全部gate收据 |
| `sync-worker/` | 同步模块旧行为oracle、表征/RED及实际执行原件 |
| `pwa-worker-initial/` | 首个PWA worker留下的原协议、源码/输出；缺失收据见下 |
| `pwa-takeover/` | 独立takeover的协议、实际收据、源快照与新旧transcript |
| `controller-lifecycle-review/` | 真实双controller互锁回归与独立报告 |
| `scope-name-race-review/` | 原竞态probe/RED、最终测试和范围复核原报告 |
| `e2e-settle-repair-review/` | 105持仓V1失败的原trace/screenshot/error-context复制、旧测试及修复范围说明 |
| `archive-first-attempt/`, `archive-second-attempt/` | 两次归档工具实际失败的原script/before收据和明确观察说明 |
| `browser-results-failed-v1/` | 实际失败目录5文件，包含trace/screenshot/error-context |
| `browser-results-passed-v3/` | 实际成功目录2文件：last-run及accuracy生命周期JSON；没有虚构成功trace/screenshot |
| `final-source/` | 最终257非历史源payload；24份`.codex-tmp/`历史Android文件仅完整库存 |
| `selected-site/` | 当前105非`assets/ocr/`文件；该目录24文件（23资源加manifest）仅完整库存，不等于遗漏未知文件 |

node_modules及OCR重型生成资产不打包，68安装身份和完整129产物库存仍保留，不声称包含全部依赖/模型payload。没有真实用户截图、浏览器profile或用户Storage导出。

## 真实失败不改判

1. 首次集成全量测试两条旧源码位置断言失败；只迁移到真实controller并保留App委托检查。
2. QA V1单测1403 PASS/3 skip，浏览器34/35。105持仓用例在请求完成前瞬时`allTextContents()`读到`--`，原trace与8秒默认超时保留。仅将同105值改为可等待的`toHaveText`及一次cache写完成断言，无sleep、retry、延长超时或放宽数值/日期/请求/写次数。
3. QA V2单测1407 PASS/2 FAIL/3 skip；两条旧结构断言仍要求3参数publish与无options reconcile。只迁移真实显式参数及settlement接线检查，另立V3，原V2不改判PASS。
4. 某集成定向测试child为104/104/native0，但外层report wrapper读取错误的receipt字段导致exit1；两层状态分开，不称业务RED。
5. 归档a1实际native1：误将129减23资源推为106，实际按路径排除24文件后是105；复制前停止。a2仅改计数，实际native1：筛查命中既有脱敏测试假Token，复制前停止。a3只允许精确文件SHA及两个已人工核实的假Token字符串hash，同时保持其他扫描。两个失败script/before收据与观察说明均保留，不补造未保存的独立native失败输出。

安全筛查对全部选定文本执行高置信Token/private-key形状检查与禁止路径检查，只有`final-source/test/integrity.test.js`两处已审核合成夹具获精确hash允许；不在README输出值。未知命中为0，禁止路径为0。这不是完整秘密扫描认证或二进制内容安全审计。

## 明确的原件缺口与边界

- 最初PWA worker有stdout/stderr但未单独保存native-exit收据；不事后重建。takeover有收据/协议/transcript但没有原`REPORT.md`。
- 早期patch排序/hunk wrapper失败及部分scope probe/只读语法输出只存在会话工具结果，没有独立保存的native原件；原script/report收录，不补造收据。
- 原5项补名RED收据存在；第6项接线测试没有修复前RED，不扩大表述。
- 成功浏览器用例只有实际落盘的last-run/accuracy文件，不把内存attachment或未生成trace当原件。
- 本次及既有E2E为固定合成数据的本地桌面Chrome；未做真实金融源对账、真实Gist写读、OCR长图识别、手机/PWA升级或生产验证。归档完整性不等于这些功能通过，数据可信度仍限合成本地范围。
