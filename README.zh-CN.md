[English](README.md) | 简体中文

# dsh-gee

给 DeepSeek Harness（dsh）用的 Google Earth Engine 插件。装上之后 agent 可以检索数据目录、跑任意
Python 分析、在地图面板上叠图层、批量导出、管理资产。整条链路由一个常驻 worker 持有 Earth Engine 会话，
认证和代理只需要配一次，不用每次调用都重新来。

## 快速开始

如果还没有装 DeepSeek Harness，先到这里装：<https://www.deepseek.com/harness/>。

然后给 agent 发一句话：

> 安装 https://github.com/cdllI/dsh-gee 这个插件，并连上我的 Earth Engine 账号。

这个地址是**一个 Git 仓库，不是 npm 包**——插件管理器不能直接吃它。它必须先克隆下来，然后把克隆里
的 `dsh-gee/` 目录装成 bundle。agent 会按这个顺序做完：

1. **克隆**：`git clone https://github.com/cdllI/dsh-gee`。如果代理劫持了 GitHub：
   `git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/cdllI/dsh-gee`
2. **装 bundle**：`install_bundle`，参数是 `<克隆目录>/dsh-gee` 的绝对路径。它改的是 profile，
   需要一次完全权限的审批。**不要手工改 `cordis.patch.yml`**——缩进错一格整个 profile 就起不来
3. **建环境**：`gee_setup action=install`——找到 DSH 自带的 Python，建私有虚拟环境，装
   `earthengine-api`、`tifffile`、`matplotlib`
4. **授权**：`gee_setup action=auth` 会打印浏览器链接。必须走 `--auth_mode localhost` 流程，
   已经废弃的 out-of-band 流程会返回 `400 invalid_request`
5. **配置 + 验证**：把 Cloud 项目号交给 `gee_setup action=verify`，它会顺便跑一次真实的
   Earth Engine 往返

你只需要做两件事：**在浏览器里点“允许”**，以及**告诉它你的 Cloud 项目 ID**。

如果你的 agent 没有 shell 权限，按下面 [安装](#安装) 里的手动步骤走。

## 功能

| 工具 | 作用 |
|---|---|
| `gee_status` | 凭据、项目、代理、worker 解释器，以及一次服务端往返。出问题先看它。 |
| `gee_eval` | 在 `ee` 作用域里跑 Python，`result` 里的值以 JSON 返回。 |
| `gee_preview` | 把 `ee.Image` 渲成 PNG 贴进对话，支持波段、拉伸、调色板和区域。 |
| `gee_catalog` | 对全部已发布数据集（约 1160 个）的 STAC 索引做关键词检索，避免模型瞎猜集合 ID。 |
| `gee_download` | 直接把影像下载成 GeoTIFF 落到工作区，**不经过 Drive 或 Cloud Storage**。支持 `chunked`（切网格逐块下载后本地拼接）和 `clipAsset`（按资产边界裁剪并写入 nodata）。 |
| `gee_export` | 批量导出到 Google Drive 或 Earth Engine 资产，返回 task id。 |
| `gee_tasks` | 列出、查看、取消批量任务。 |
| `gee_assets` | 列出、查看、移动、删除 `projects/<project>/assets` 下的资产。 |
| `gee_layer` | 往地图面板加图层、移除图层、列出图层栈。 |

插件还带一个地图面板（左栏 GEE 图标）：Leaflet 地图 + 图层栈 + 资产浏览器。资产树可以直接展开
`projects/<project>/assets`，点 IMAGE 类型的资产就叠到地图上。

## 环境要求

- 装好插件管理器的 DeepSeek Harness。
- Python 3.10+，且安装了 `earthengine-api`、`numpy`、`tifffile`，Harness 进程能调用它。
  `numpy` 和 `tifffile` 只有 `clipAsset` 和 `chunked` 用到；bootstrap 脚本会把三个一起装上。
- 一个已启用 Earth Engine、且你的账号已注册的 Google Cloud 项目。
- 如果所在网络访问不了 Google：一个本机可达的 HTTPS 代理。

**没有使用 Earth Engine 的 Node 客户端。** 它无法用 `earthengine authenticate` 写出的 refresh token
完成认证，也会忽略 `HTTPS_PROXY`。只有 Python worker 能同时解决这两件事，而且批量导出、资产管理这些
接口在 Python 侧最完整。

## 安装

### Windows 一键配置

DSH 自带 Python 3.12 运行时，所以**不需要手动装任何东西**。给 agent 发一句：

> 用 `gee_setup` 配置这个插件：check、install、auth、verify。

它会找到 DSH 的运行时、建私有虚拟环境、装 `earthengine-api` / `tifffile` / `matplotlib`
（插件旁边有 `wheels/` 目录时全程离线）、写 `gee.config.json`、返回浏览器授权链接。
你只需要点一次「允许」、给一次项目号。

下面的手动步骤用于排查问题，或没有发布 wheelhouse 的平台。

### 1. 准备一个装了 Earth Engine 的 Python

```bash
python -m venv .venv
.venv/bin/pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple earthengine-api
# Windows: .venv\Scripts\pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple earthengine-api
```

**pip 不要走代理。** 这是整个安装里最慢的一步：同一个 wheel，直连 PyPI 光是打开索引就要约 12 秒，
走国内镜像不到 1 秒；整套依赖装下来从十分钟级降到秒级。也可以直接用脚本，它会把 venv 和镜像源都处理好：

```bash
sh tools/bootstrap.sh        # Windows: powershell -File tools\bootstrap.ps1
```

### 2. 登录

```bash
.venv/bin/earthengine authenticate --auth_mode localhost
# Windows: .venv\Scripts\earthengine.exe authenticate --auth_mode localhost
```

**`--auth_mode localhost` 不能省。** 客户端默认的 redirect 是 `urn:ietf:wg:oauth:2.0:oob`，这个 OAuth 流程
Google 在 2022 年就停用了，授权页会直接返回 `Error 400: invalid_request`。localhost 模式会在 8085 端口起一个
本地回调服务，这是目前唯一还能用的流程。8085 被占用时用 `--auth_mode localhost:0`（自动选端口）。

这一步把 refresh token 写到 `~/.config/earthengine/credentials`。插件会自己刷新 access token，
所以只需要做一次。之后如果 token 被撤销，`gee_status` 会报出来，重新跑一遍即可。

如果 Harness 跑在**家目录不可写**的环境里（容器、沙箱宿主），把 `home` 指到一个可写目录，并用同样的值登录：

```bash
USERPROFILE=/writable/dir .venv/bin/earthengine authenticate
# Windows: $env:USERPROFILE='D:\writable\dir'; .venv\Scripts\earthengine authenticate
```

插件会把 `home` 当作 `USERPROFILE` / `HOME` 传给 worker，Earth Engine 就会去那里找凭据。

### 3. 配置

把 `dsh-gee/gee.config.example.json` 复制成 `dsh-gee/gee.config.json` 再填。这个文件是**机器本地**的，
已经在 `.gitignore` 里，不需要也不应该跟别人的路径一致。

```json
{
  "python": "/path/to/.venv/bin/python",
  "project": "your-earth-engine-project-id",
  "proxy": "http://127.0.0.1:7890",
  "home": "",
  "approval": "ask",
  "timeoutMs": 180000
}
```

| 键 | 含义 | 默认 |
|---|---|---|
| `python` | 装了 `earthengine-api` 的解释器 | `PATH` 里的 `python` |
| `project` | 承载 Earth Engine 配额的 Cloud 项目；凭据文件里有时也会自动读到 | 无 |
| `proxy` | 以 `HTTPS_PROXY` / `HTTP_PROXY` 传给 worker | 空 |
| `home` | 设置 worker 的 `USERPROFILE` / `HOME`，让凭据可以放在别处 | 继承 |
| `approval` | `ask`：导出、资产删除/移动、分块下载走审批；`off`：不询问直接执行 | `ask` |
| `timeoutMs` | 单次调用超时 | `120000` |

提交到仓库的 Loader patch 里**故意没有 config 行**，profile 里写 `config` 仍然优先于这个文件——
所以仓库里不会出现任何人的本地路径。

### 4. 安装 bundle

`https://github.com/cdllI/dsh-gee` 是仓库，不是 npm 包——插件管理器不能直接装。必须先克隆，再装克隆
里的 `dsh-gee/` 目录：

```bash
git clone https://github.com/cdllI/dsh-gee
# 代理劫持了 GitHub
git -c http.proxy=http://127.0.0.1:7890 clone https://github.com/cdllI/dsh-gee
```

如果 `web_fetch` 报 `URL hostname resolves to a non-public IP address`，那是本地代理把域名映射到了私有
地址：按上面的写法带代理克隆，或者用 `api.github.com`、`raw.githubusercontent.com` 读文件——这两个域名
解析是公网的。

然后在插件管理器里 **安装 bundle**，路径填 `<克隆目录>/dsh-gee` 的绝对路径，或者让 agent 调
`install_bundle`。它改的是 profile，需要一次完全权限的审批。

**不要手工改 profile 里的 `cordis.patch.yml` 或 `package.json`**；缩进错一格，profile 就起不来了。

装完刷新页面，客户端那一半才会加载；左侧栏会出现 **GEE** 图标。

### 5. 验证

让 agent 调一次 `gee_status`。正常的话会显示凭据路径、项目、代理，以及 `server round-trip: ok`。

## 用法

```python
# gee_eval：result 里的值会以 JSON 返回
col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")
result = col.size()
```

如果代码里留了未关闭的 matplotlib 图，插件会把图截图并作为图片贴回对话——TVDI 干湿边、直方图、时间序列
这类图就是这样给到你的。同一个 Python 环境里装 `matplotlib` 即可启用。

```python
# gee_preview：必须在 result 里留下一个 ee.Image
result = col.median().select(["B4", "B3", "B2"])
# bands=["B4","B3","B2"], min=0, max=3000, region=[西, 南, 东, 北], dimensions=900
```

```python
# gee_download：GeoTIFF 落到 ./exports，按资产边界裁剪，nodata 已声明
result = ee.Image("USGS/SRTMGL1_003").select("elevation").rename("dem")
# region=[...], scale=500, clipAsset="projects/<project>/assets/<table>"
```

```python
# gee_layer：把同一个表达式加到地图面板
result = col.median().select(["B4", "B3", "B2"])
# name="S2 真彩色", bands=[...], min=0, max=3000
```

## 权限与安全

- 每一段执行的代码都会写成 `scripts/gee-<时间戳>-<类型>.py`，文件头记录项目、区域和 scale，
  工具结果里会带路径。任何结果都能追溯到确切的那份代码。
- `gee_export`、`gee_assets delete` / `move`，以及分块 `gee_download` 会先请求审批。审批是**失败关闭**的：
  没有审批服务，或者返回值不是 `allowed-once`，一律拒绝。只有无人值守的批量任务才建议设
  `"approval": "off"`。
- worker 用**你的 Earth Engine 凭据**执行模型写的 Python，没有额外沙箱。请把这个插件理解为
  “agent 可以拿你的账号做任何事”。

## 工作原理

```
Harness 宿主 (Node)                  Python worker（常驻）                  Google
  dsh-gee/index.js  -- JSON 行 -->     worker.py  -- earthengine-api -->   Earth Engine API
    工具、图层栈、HTTP 路由              认证、批量、资产、瓦片                （走 HTTPS_PROXY）
```

- 宿主那一半注册工具、维护图层栈、提供地图面板的 HTTP 路由。
- worker 持有一个初始化好的 Earth Engine 会话，每次调用不用重新 import 和认证。
- 地图瓦片由**浏览器直接**向 `earthengine.googleapis.com` 请求。mapid 不可猜且不需要鉴权，
  所以宿主不代理瓦片字节。
- 面板每两秒轮询一次 `GET /gee/state`。图层栈在内存里，应用重启就清空。

## 限制

- `clipAsset` 不能和 `chunked` 同时用，会直接报错而不是静默忽略。
- 分块拼接用的是中纬度度数网格，跟 Earth Engine 自己的下载网格不是逐像素一致。
- 本地文件不能变成资产：EE 的入库接口只接受 `gs://` 路径。

## 开发

配置、重载方式和踩过的坑都在 [AGENTS.md](AGENTS.md)。改完跑一次：

```bash
node tools/check-plugin.mjs dsh-gee
```

## 许可

MIT。Earth Engine 的使用受 Google 服务条款约束，本项目只是对公开 API 的封装。
