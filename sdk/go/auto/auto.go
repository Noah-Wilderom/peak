// Package auto starts the Peak agent as soon as your program loads:
//
//	import _ "github.com/Noah-Wilderom/peak/sdk/go/auto"
//
// It does nothing at all unless the program was started by Peak.
package auto

import peak "github.com/Noah-Wilderom/peak/sdk/go"

func init() {
	peak.Start()
}
