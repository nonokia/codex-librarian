module "vpc" {
  source = "./modules/vpc"

  name = local.name_prefix
  cidr = "10.0.0.0/16"
  azs  = data.aws_availability_zones.available.names

  tags = local.common_tags
}
