package setup

import (
	"github.com/IAmForeverAloneToo/ccunified-dashboard/agent/internal/serverassets"
)

func defaultAssets() Assets {
	return Assets{Worker: serverassets.Worker, Migrations: serverassets.Migrations}
}
