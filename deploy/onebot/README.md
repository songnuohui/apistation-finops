# NapCat OneBot deployment

This deployment keeps the NapCat WebUI on the server loopback only:

```text
http://127.0.0.1:6099/webui
```

The OneBot HTTP API is intentionally not published on a host port. FinOps
reaches it over the private Docker network at:

```text
http://napcat:3000
```

The QQ login state and NapCat configuration persist under:

```text
/opt/apistation-finops/onebot/
```

Use an SSH tunnel to access the WebUI from the operator workstation:

```bash
ssh -L 6099:127.0.0.1:6099 root@38.49.216.189
```

Then open `http://127.0.0.1:6099/webui` locally.
