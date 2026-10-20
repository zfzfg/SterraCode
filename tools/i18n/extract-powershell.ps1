# Parse text supplied over stdin. No audited script is invoked or dot-sourced.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$results = @(foreach ($item in $items) {
    $tokens = $null
    $parseErrors = $null
    $tree = [Management.Automation.Language.Parser]::ParseInput([string]$item.source, [ref]$tokens, [ref]$parseErrors)
    $records = @($tree.FindAll({ param($node)
        $node -is [Management.Automation.Language.StringConstantExpressionAst] -or $node -is [Management.Automation.Language.ExpandableStringExpressionAst]
    }, $true) | ForEach-Object {
        $node = $_
        $context = ''
        $role = 'value'
        if ($node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'BareWord') { $role = 'bareword' }
        $parent = $node.Parent
        while ($null -ne $parent) {
            if ($parent -is [Management.Automation.Language.ThrowStatementAst]) { $context = 'throw'; break }
            if ($parent -is [Management.Automation.Language.CommandAst] -and -not $context) {
                $context = [string]$parent.GetCommandName()
                if ($parent.CommandElements[0] -eq $node) { $role = 'command-name' }
            }
            $parent = $parent.Parent
        }
        @{
            line = $node.Extent.StartLineNumber; endLine = $node.Extent.EndLineNumber
            column = $node.Extent.StartColumnNumber; start = $node.Extent.StartOffset; end = $node.Extent.EndOffset
            kind = $(if ($node -is [Management.Automation.Language.ExpandableStringExpressionAst]) { 'powershell-template' } else { 'powershell-string' }); role = $role; context = $context; text = [string]$node.Value
        }
    })
    $comments = @($tokens | Where-Object { $_.Kind -eq 'Comment' } | ForEach-Object {
        @{ line = $_.Extent.StartLineNumber; endLine = $_.Extent.EndLineNumber; column = $_.Extent.StartColumnNumber; kind = 'powershell-comment'; role = 'comment'; text = $_.Text }
    })
    @{ file = $item.file; records = @($records) + @($comments); errors = @($parseErrors | ForEach-Object { $_.Message }) }
})
ConvertTo-Json -InputObject @($results) -Depth 20 -Compress
