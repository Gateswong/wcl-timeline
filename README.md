# WoW Log Timeline

把 Warcraft Logs 的 report 以纵向时间轴展示：主轴为某玩家的施法序列，右侧可叠加其他玩家施法、单位血量、Buff/Debuff、资源、死亡/召唤/打断等事件，并标注 Phase / Intermission。

- `src/Api` — ASP.NET Core (.NET 10) 最小 API：代理 WCL v2 GraphQL（OAuth client credentials、内存缓存、分页、归一化）
- `src/web` — Angular 前端；`ng build` 输出到 `src/Api/wwwroot`，由 API 一并托管

## 1. 配置 WCL 凭据
在 https://www.warcraftlogs.com/api/clients 创建 client（Redirect URL 随便填，只用 client credentials），然后：

```bash
cd src/Api
dotnet user-secrets set "Wcl:ClientId" "<id>"
dotnet user-secrets set "Wcl:ClientSecret" "<secret>"
```
部署到 VPS 时用环境变量 `Wcl__ClientId` / `Wcl__ClientSecret`。

## 2. 本地开发
```bash
cd src/Api && dotnet run --urls http://localhost:5282     # 后端
cd src/web && npx ng serve                                # 前端 http://localhost:4200 ，/api 代理到 5282
```

## 3. 部署（Docker + Caddy，地址 https://wow.1up.moe/wcl-timeline/）
应用部署在子路径 `/wcl-timeline/` 下：Caddy 去掉前缀后转给 API，前端以 `--base-href /wcl-timeline/` 构建，接口用相对路径。

1. DNS：把 `wow.1up.moe` 的 A 记录指向 VPS，放行 80/443。
2. 把项目目录传到 VPS（不用传 `node_modules`、`bin`、`obj`、`src/Api/wwwroot`，`.dockerignore` 已忽略它们）。
3. 在 VPS 上：
```bash
cp .env.example .env     # 填入 Wcl__ClientId / Wcl__ClientSecret
docker compose up -d --build
```
4. 打开 https://wow.1up.moe/wcl-timeline/ 。更新代码后再次 `docker compose up -d --build`。

如果 `wow.1up.moe` 已经由别的 Caddy 在服务，只需把 `deploy/Caddyfile` 站点块里的两段（`redir` 和 `handle_path`）合并进去，并让它能访问 `app:8080`（同一 docker 网络），同时去掉 compose 里的 `caddy` 服务。

注意：凭据在服务端，所有访问者共用你的 WCL 配额（事件结果在内存里缓存 6 小时）。目前没有访问限制。

## 当前能力 / 已知限制
- 列类型：施法序列、Buff/Debuff 区间、血量 %（来自 DamageTaken/Healing 事件的 hitPoints）、资源（来自施法事件的 classResources）、死亡/召唤/打断/驱散/复活、受到伤害/治疗（含原始伤害、减免、吸收、过量治疗等明细）。
- 同名单位（如多只小怪）自动合并为一组，最多取 12 个实例。
- 列配置：地址栏 URL 即分享链接（`?report=&fight=&c=`），列按单位名存储（玩家和 NPC 都按名称精确匹配，不会用其他玩家顶替），切换战斗/Report 会自动沿用；找不到对应单位的列保持原配置不动，列头给出提示（再切到有该单位的战斗会自动恢复）。地址栏 URL 就是配置，直接复制分享或收藏即可。
- 尚未实现：“当前目标”列、事件很密集时的虚拟滚动。
- 已用示例 report（6qVxPcBdCgXrkG8a fight 179）验证：施法、Buff/Debuff、血量、资源、死亡/召唤、阶段均能返回并渲染。
- WCL 事件接口的 `hostilityType` 指**来源**一方，且 DamageTaken 视图里 sourceID 实际是受害者；后端已按此处理（见 `ReportService.cs`）。
- 本地开发运行 API 时需设置 `ASPNETCORE_ENVIRONMENT=Development`，user-secrets 才会生效（`launchSettings` 的 http profile 已设置）。
